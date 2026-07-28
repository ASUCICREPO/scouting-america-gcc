import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';
import { PREFIX } from '../config/environment';

export interface ChatArchiveProps {
  chatLogsTable: dynamodb.ITable;
  archiveBucket: s3.IBucket;
}

/**
 * Copies inserted chat turns from DynamoDB into an object-locked S3 archive.
 *
 * A stream keeps archival off the synchronous chat path. The Lambda has put
 * permission only: it cannot read, overwrite in place, or delete audit objects.
 */
export class ChatArchive extends Construct {
  public readonly function: lambda.Function;
  public readonly deadLetterQueue: sqs.Queue;

  constructor(scope: Construct, id: string, props: ChatArchiveProps) {
    super(scope, id);

    this.deadLetterQueue = new sqs.Queue(this, 'ChatArchiveDLQ', {
      queueName: `${PREFIX}GCC-ChatArchive-DLQ`,
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      retentionPeriod: cdk.Duration.days(14),
    });

    this.function = new lambda.Function(this, 'ChatArchiveFunction', {
      functionName: `${PREFIX}GCC-ChatArchiver`,
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../../lambda/chat-archiver')),
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {
        ARCHIVE_BUCKET: props.archiveBucket.bucketName,
      },
      logGroup: new logs.LogGroup(this, 'ChatArchiveLogs', {
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });

    props.archiveBucket.grantPut(this.function);
    this.function.addEventSource(new sources.DynamoEventSource(props.chatLogsTable, {
      startingPosition: lambda.StartingPosition.LATEST,
      batchSize: 10,
      bisectBatchOnError: true,
      retryAttempts: 5,
      reportBatchItemFailures: true,
      onFailure: new sources.SqsDlq(this.deadLetterQueue),
    }));
  }
}
