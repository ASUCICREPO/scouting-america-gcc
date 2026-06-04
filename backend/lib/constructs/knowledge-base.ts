import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as bedrock from 'aws-cdk-lib/aws-bedrock';
import { Construct } from 'constructs';
import { CONFIG } from '../config/environment';

export interface KnowledgeBaseProps {
  // S3 bucket where processed document chunks live (from Advait's shared-resources)
  knowledgeBaseBucket: s3.IBucket;
}

export class KnowledgeBase extends Construct {
  // The KB ID — Chat Handler needs this to call RetrieveAndGenerate
  public readonly knowledgeBaseId: string;

  constructor(scope: Construct, id: string, props: KnowledgeBaseProps) {
    super(scope, id);

    // IAM role that Bedrock KB uses to read from S3
    const kbRole = new iam.Role(this, 'KBRole', {
      roleName: 'GCC-BedrockKB-Role',
      assumedBy: new iam.ServicePrincipal('bedrock.amazonaws.com'),
      description: 'Allows Bedrock KB to read document chunks from S3',
    });

    // Let Bedrock read from the KB data bucket
    props.knowledgeBaseBucket.grantRead(kbRole);

    // Also need bedrock:InvokeModel for embeddings
    kbRole.addToPolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel'],
      resources: [`arn:aws:bedrock:${cdk.Aws.REGION}::foundation-model/${CONFIG.EMBEDDING_MODEL_ID}`],
    }));

    // Create the Bedrock Knowledge Base (L1 construct — CfnKnowledgeBase)
    // This is the "brain" that indexes documents and answers questions
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
      // Bedrock manages the vector store (OpenSearch Serverless under the hood)
      storageConfiguration: {
        type: 'OPENSEARCH_SERVERLESS',
        opensearchServerlessConfiguration: {
          collectionArn: '', // Bedrock auto-creates this when using managed storage
          vectorIndexName: 'gcc-docs-index',
          fieldMapping: {
            vectorField: 'embedding',
            textField: 'text',
            metadataField: 'metadata',
          },
        },
      },
    });

    // Data source — tells the KB where to find documents (our S3 bucket)
    new bedrock.CfnDataSource(this, 'S3DataSource', {
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
  }
}
