import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sources from 'aws-cdk-lib/aws-lambda-event-sources';
import { Construct } from 'constructs';
import { PREFIX } from '../config/environment';

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
  /** The Lambda worker and queue — S3 notifications must target the queue. */
  public readonly function: lambda.Function;
  public readonly processingQueue: sqs.Queue;
  public readonly deadLetterQueue: sqs.Queue;

  constructor(scope: Construct, id: string, props: DocProcessorProps) {
    super(scope, id);

    this.deadLetterQueue = new sqs.Queue(this, 'DocProcessorDLQ', {
      queueName: `${PREFIX}GCC-DocProcessor-DLQ`,
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      retentionPeriod: cdk.Duration.days(14),
    });
    this.processingQueue = new sqs.Queue(this, 'DocProcessorQueue', {
      queueName: `${PREFIX}GCC-DocProcessor-Queue`,
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      retentionPeriod: cdk.Duration.days(14),
      visibilityTimeout: cdk.Duration.minutes(6),
      deadLetterQueue: {
        queue: this.deadLetterQueue,
        maxReceiveCount: 3,
      },
    });

    this.function = new lambda.Function(this, 'DocProcessorFunction', {
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../../lambda/doc-processor')),
      timeout: cdk.Duration.minutes(5),
      memorySize: 512,
      // Keep document jobs from consuming the account's Lambda concurrency and
      // serialize ingestion starts for this single Bedrock data source.
      reservedConcurrentExecutions: 2,
      environment: {
        KNOWLEDGE_BASE_BUCKET: props.knowledgeBaseBucket.bucketName,
        ANALYTICS_TABLE: props.analyticsTable.tableName,
        KNOWLEDGE_BASE_ID: props.knowledgeBaseId,
        DATA_SOURCE_ID: props.dataSourceId,
      },
      description: 'Copies uploaded documents to KB bucket and triggers Bedrock ingestion',
      logGroup: new logs.LogGroup(this, 'DocProcessorLogs', {
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });
    this.function.addEventSource(new sources.SqsEventSource(this.processingQueue, {
      batchSize: 1,
      maxConcurrency: 2,
    }));

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
