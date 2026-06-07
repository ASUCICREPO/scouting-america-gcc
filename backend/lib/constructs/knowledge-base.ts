import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as bedrock from 'aws-cdk-lib/aws-bedrock';
import * as s3vectors from 'aws-cdk-lib/aws-s3vectors';
import { Construct } from 'constructs';
import { CONFIG } from '../config/environment';

export interface KnowledgeBaseProps {
  // S3 bucket where processed document chunks live (from shared-resources)
  knowledgeBaseBucket: s3.IBucket;
}

export class KnowledgeBase extends Construct {
  // The KB ID — Chat Handler needs this to call RetrieveAndGenerate
  public readonly knowledgeBaseId: string;
  // The Data Source ID — Doc Processor needs this for StartIngestionJob
  public readonly dataSourceId: string;

  constructor(scope: Construct, id: string, props: KnowledgeBaseProps) {
    super(scope, id);

    // --- S3 Vector Bucket & Index (replaces OpenSearch Serverless) ---
    // S3 Vectors: ~90% cost reduction vs OpenSearch Serverless ($700+/mo minimum)
    // Pay-per-query with no idle cost — ideal for a nonprofit with ~3,000 volunteers
    const vectorBucket = new s3vectors.CfnVectorBucket(this, 'VectorBucket', {
      vectorBucketName: 'gcc-volunteer-vectors',
    });

    // Vector index — Titan Text Embeddings v2 outputs 1024 dimensions
    const vectorIndex = new s3vectors.CfnIndex(this, 'VectorIndex', {
      vectorBucketName: vectorBucket.vectorBucketName!,
      indexName: 'gcc-docs-index',
      dimension: 1024,
      distanceMetric: 'cosine',
      dataType: 'float32',
    });
    vectorIndex.addDependency(vectorBucket);

    // IAM role that Bedrock KB uses to read source docs and access S3 Vectors
    const kbRole = new iam.Role(this, 'KBRole', {
      roleName: 'GCC-BedrockKB-Role',
      assumedBy: new iam.ServicePrincipal('bedrock.amazonaws.com'),
      description: 'Allows Bedrock KB to access S3 Vectors and source documents',
    });

    // Let Bedrock read from the KB data bucket (source document chunks)
    props.knowledgeBaseBucket.grantRead(kbRole);

    // Bedrock needs InvokeModel for generating embeddings
    kbRole.addToPolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel'],
      resources: [`arn:aws:bedrock:${cdk.Aws.REGION}::foundation-model/${CONFIG.EMBEDDING_MODEL_ID}`],
    }));

    // Bedrock needs S3 Vectors permissions to store and query vector embeddings
    kbRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        's3vectors:PutVectors',
        's3vectors:QueryVectors',
        's3vectors:GetVectors',
        's3vectors:DeleteVectors',
        's3vectors:ListVectors',
        's3vectors:GetIndex',
        's3vectors:GetVectorBucket',
      ],
      resources: [
        vectorBucket.attrVectorBucketArn,
        vectorIndex.attrIndexArn,
      ],
    }));

    // Create the Bedrock Knowledge Base with S3 Vectors storage
    const kb = new bedrock.CfnKnowledgeBase(this, 'GccKnowledgeBase', {
      name: 'GCC-VolunteerSupport-KB',
      description: 'Knowledge base for GCC volunteer support — contains approved Scouting America and GCC documents',
      roleArn: kbRole.roleArn,
      knowledgeBaseConfiguration: {
        type: 'VECTOR',
        vectorKnowledgeBaseConfiguration: {
          embeddingModelArn: `arn:aws:bedrock:${cdk.Aws.REGION}::foundation-model/${CONFIG.EMBEDDING_MODEL_ID}`,
        },
      },
      storageConfiguration: {
        type: 'S3_VECTORS',
        s3VectorsConfiguration: {
          vectorBucketArn: vectorBucket.attrVectorBucketArn,
          indexArn: vectorIndex.attrIndexArn,
          indexName: 'gcc-docs-index',
        },
      },
    });
    kb.addDependency(vectorIndex);

    // Data source — tells the KB where to find documents (S3 bucket with chunks)
    const dataSource = new bedrock.CfnDataSource(this, 'S3DataSource', {
      name: 'GCC-Documents-S3',
      description: 'Processed document chunks from the GCC document store',
      knowledgeBaseId: kb.attrKnowledgeBaseId,
      dataSourceConfiguration: {
        type: 'S3',
        s3Configuration: {
          bucketArn: props.knowledgeBaseBucket.bucketArn,
          inclusionPrefixes: ['chunks/'], // only index the chunks folder
        },
      },
      vectorIngestionConfiguration: {
        chunkingConfiguration: {
          chunkingStrategy: 'FIXED_SIZE',
          fixedSizeChunkingConfiguration: {
            maxTokens: 300,
            overlapPercentage: 20,
          },
        },
      },
    });

    // Export the KB ID so Chat Handler can use it
    this.knowledgeBaseId = kb.attrKnowledgeBaseId;
    // Export the Data Source ID so Doc Processor can call StartIngestionJob
    this.dataSourceId = dataSource.attrDataSourceId;
  }
}
