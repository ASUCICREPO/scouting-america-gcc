import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as bedrock from 'aws-cdk-lib/aws-bedrock';
import * as s3vectors from 'aws-cdk-lib/aws-s3vectors';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import { CONFIG, PREFIX } from '../config/environment';

export interface KnowledgeBaseProps {
  // S3 bucket where processed document chunks live (from shared-resources)
  knowledgeBaseBucket: s3.IBucket;
}

export class KnowledgeBase extends Construct {
  // The KB ID — Chat Handler uses it for the single retrieval step
  public readonly knowledgeBaseId: string;
  // The Data Source ID — Doc Processor needs this for StartIngestionJob
  public readonly dataSourceId: string;

  constructor(scope: Construct, id: string, props: KnowledgeBaseProps) {
    super(scope, id);

    // --- S3 Vector Bucket & Index (replaces OpenSearch Serverless) ---
    // S3 Vectors: ~90% cost reduction vs OpenSearch Serverless ($700+/mo minimum)
    // Pay-per-query with no idle cost — ideal for a nonprofit with ~3,000 volunteers
    const vectorBucket = new s3vectors.CfnVectorBucket(this, 'VectorBucket', {
      vectorBucketName: CONFIG.VECTOR_BUCKET,
    });

    // Vector index — Titan Text Embeddings v2 outputs 1024 dimensions
    const vectorIndex = new s3vectors.CfnIndex(this, 'VectorIndex', {
      vectorBucketName: vectorBucket.vectorBucketName!,
      indexName: CONFIG.VECTOR_INDEX,
      dimension: 1024,
      distanceMetric: 'cosine',
      dataType: 'float32',
      // S3 Vectors caps *filterable* metadata at 2KB per vector (40KB total).
      // Bedrock stores the chunk text in AMAZON_BEDROCK_TEXT and a source blob in
      // AMAZON_BEDROCK_METADATA — both routinely exceed 2KB. Declaring them
      // non-filterable moves them into the 40KB total budget so PutVectors (and
      // therefore ingestion + chat retrieval) succeeds. These keys are immutable
      // after index creation, so changing them forces an index replacement.
      metadataConfiguration: {
        nonFilterableMetadataKeys: ['AMAZON_BEDROCK_TEXT', 'AMAZON_BEDROCK_METADATA'],
      },
    });
    vectorIndex.addResourceDependency(vectorBucket);

    // IAM role that Bedrock KB uses to read source docs and access S3 Vectors
    const kbRole = new iam.Role(this, 'KBRole', {
      roleName: CONFIG.KB_ROLE_NAME,
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

    // The foundation-model parser invokes the parsing model through its
    // cross-region inference profile, which can route to any US region.
    const parsingModelArn = `arn:aws:bedrock:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:inference-profile/${CONFIG.KB_PARSING_MODEL_ID}`;
    const parsingFoundationModelId = CONFIG.KB_PARSING_MODEL_ID.replace(/^[a-z]+\./, '');
    kbRole.addToPolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel', 'bedrock:GetInferenceProfile'],
      resources: [
        parsingModelArn,
        `arn:aws:bedrock:*::foundation-model/${parsingFoundationModelId}`,
      ],
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
        's3vectors:ListIndexes',
        's3vectors:GetVectorBucket',
      ],
      resources: [
        vectorBucket.attrVectorBucketArn,
        `${vectorBucket.attrVectorBucketArn}/*`,
        vectorIndex.attrIndexArn,
      ],
    }));

    // Resource-based policy on the vector bucket to allow the KB role access
    // This ensures Bedrock can validate the connection even before identity policy propagates
    new s3vectors.CfnVectorBucketPolicy(this, 'VectorBucketPolicy', {
      vectorBucketName: vectorBucket.vectorBucketName!,
      policy: {
        Version: '2012-10-17',
        Statement: [{
          Effect: 'Allow',
          Principal: { AWS: kbRole.roleArn },
          Action: [
            's3vectors:PutVectors',
            's3vectors:QueryVectors',
            's3vectors:GetVectors',
            's3vectors:DeleteVectors',
            's3vectors:ListVectors',
            's3vectors:GetIndex',
            's3vectors:ListIndexes',
            's3vectors:GetVectorBucket',
          ],
          Resource: [
            vectorBucket.attrVectorBucketArn,
            `${vectorBucket.attrVectorBucketArn}/*`,
            vectorIndex.attrIndexArn,
          ],
        }],
      },
    });

    // Create the Bedrock Knowledge Base with S3 Vectors storage
    const kb = new bedrock.CfnKnowledgeBase(this, 'GccKnowledgeBase', {
      name: `${PREFIX}GCC-VolunteerSupport-KB`,
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
        },
      },
    });
    kb.addResourceDependency(vectorIndex);
    // Ensure IAM policies are fully created before KB validates the S3 Vectors connection
    kb.node.addDependency(kbRole);

    // The default parser only extracts embedded text: it rejects scanned PDFs
    // and flattens calendar grids so dates lose their weekdays. A foundation
    // model reads each page instead, guided by kb-parsing-prompt.txt.
    // Normalize line endings so a Windows checkout neither changes the prompt
    // Bedrock receives nor forces a data-source replacement.
    const parsingPromptText = fs.readFileSync(
      path.join(__dirname, '../config/kb-parsing-prompt.txt'),
      'utf8',
    ).replace(/\r\n/g, '\n');
    const parsingConfiguration: bedrock.CfnDataSource.ParsingConfigurationProperty = {
      parsingStrategy: 'BEDROCK_FOUNDATION_MODEL',
      bedrockFoundationModelConfiguration: {
        modelArn: parsingModelArn,
        parsingPrompt: { parsingPromptText },
      },
    };
    // Parsing settings are create-only, so any change replaces the data source.
    // CloudFormation creates the replacement before deleting the original, and
    // names must be unique within a knowledge base, so derive the name from the
    // parsing settings. (The model ARN token resolves per region; the model ID
    // and prompt are what vary between deployments.)
    const parsingHash = crypto.createHash('sha256')
      .update(CONFIG.KB_PARSING_MODEL_ID)
      .update(parsingPromptText)
      .digest('hex')
      .slice(0, 8);

    // Data source — tells the KB where to find documents (S3 bucket with chunks)
    const dataSource = new bedrock.CfnDataSource(this, 'S3DataSource', {
      name: `${PREFIX}GCC-Documents-S3-${parsingHash}`,
      description: 'Processed document chunks from the GCC document store',
      knowledgeBaseId: kb.attrKnowledgeBaseId,
      dataSourceConfiguration: {
        type: 'S3',
        s3Configuration: {
          bucketArn: props.knowledgeBaseBucket.bucketArn,
          inclusionPrefixes: ['documents/'], // Bedrock handles parsing and chunking natively
        },
      },
      vectorIngestionConfiguration: {
        parsingConfiguration,
        // Semantic chunking splits by meaning boundaries for better context coherence.
        // Max 800 tokens per chunk keeps vectors within S3 Vectors metadata limits.
        chunkingConfiguration: {
          chunkingStrategy: 'SEMANTIC',
          semanticChunkingConfiguration: {
            maxTokens: 800,
            bufferSize: 1,
            breakpointPercentileThreshold: 95,
          },
        },
      },
    });

    // Bedrock checks the parsing model permissions when the data source is created.
    dataSource.node.addDependency(kbRole);

    // A new or replaced data source starts empty (the original's vectors are
    // deleted with it), so index every existing document right away instead of
    // waiting for the next upload. Keyed to the data source ID, this runs on
    // the first deploy and again whenever the data source is replaced. A sync
    // that is already running covers the same documents, so a conflict is fine.
    const startIngestion: cr.AwsSdkCall = {
      service: 'bedrock-agent',
      action: 'StartIngestionJob',
      parameters: {
        knowledgeBaseId: kb.attrKnowledgeBaseId,
        dataSourceId: dataSource.attrDataSourceId,
        description: 'Full sync after the data source was created or replaced',
      },
      physicalResourceId: cr.PhysicalResourceId.of(dataSource.attrDataSourceId),
      ignoreErrorCodesMatching: 'ConflictException',
    };
    new cr.AwsCustomResource(this, 'InitialIngestion', {
      onCreate: startIngestion,
      onUpdate: startIngestion,
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ['bedrock:StartIngestionJob'],
          resources: [kb.attrKnowledgeBaseArn],
        }),
      ]),
      installLatestAwsSdk: false,
    });

    // Export the KB ID so Chat Handler can use it
    this.knowledgeBaseId = kb.attrKnowledgeBaseId;
    // Export the Data Source ID so Doc Processor can call StartIngestionJob
    this.dataSourceId = dataSource.attrDataSourceId;
  }
}
