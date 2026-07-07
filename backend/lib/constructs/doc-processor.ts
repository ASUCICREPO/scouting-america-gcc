import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export interface DocProcessorProps {
  /** S3 bucket where raw documents are uploaded */
  documentStoreBucket: s3.IBucket;
  /** S3 bucket for processed knowledge base chunks */
  knowledgeBaseBucket: s3.IBucket;
  /** DynamoDB table for analytics logging */
  analyticsTable: dynamodb.ITable;
  /** Bedrock Knowledge Base ID */
  knowledgeBaseId: string;
  /** Bedrock Knowledge Base Data Source ID */
  dataSourceId: string;
}

export class DocProcessor extends Construct {
  /** The Lambda function reference — pass to SharedResources for S3 event notification */
  public readonly function: lambda.Function;

  constructor(scope: Construct, id: string, props: DocProcessorProps) {
    super(scope, id);

    this.function = new nodejs.NodejsFunction(this, 'DocProcessorFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '../../lambda/doc-processor/index.ts'),
      handler: 'handler',
      timeout: cdk.Duration.minutes(5),
      memorySize: 512,
      environment: {
        KNOWLEDGE_BASE_BUCKET: props.knowledgeBaseBucket.bucketName,
        ANALYTICS_TABLE: props.analyticsTable.tableName,
        KNOWLEDGE_BASE_ID: props.knowledgeBaseId,
        DATA_SOURCE_ID: props.dataSourceId,
      },
      description: 'Copies uploaded documents to KB bucket and triggers Bedrock ingestion',
      bundling: {
        minify: true,
        sourceMap: true,
      },
    });

    // Grant read access to the document store bucket
    props.documentStoreBucket.grantRead(this.function);

    // Grant read/write access to the knowledge base bucket
    props.knowledgeBaseBucket.grantReadWrite(this.function);

    // Grant write access to the analytics DynamoDB table
    props.analyticsTable.grantWriteData(this.function);

    // Grant Bedrock Agent permissions for StartIngestionJob
    this.function.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:StartIngestionJob'],
        resources: [
          `arn:aws:bedrock:*:*:knowledge-base/${props.knowledgeBaseId}`,
        ],
      }),
    );
  }
}
