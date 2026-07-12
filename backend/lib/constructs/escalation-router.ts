import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { CONFIG } from '../config/environment';
import * as path from 'path';

export interface EscalationRouterProps {
  // SNS topic to publish staff alerts to
  staffAlertTopic: sns.ITopic;
  // DynamoDB table to log escalation events
  analyticsLogsTable: dynamodb.ITable;
}

export class EscalationRouter extends Construct {
  // Expose the function so Chat Handler can reference its ARN
  public readonly function: lambda.Function;

  constructor(scope: Construct, id: string, props: EscalationRouterProps) {
    super(scope, id);

    // Dead-letter queue: this function is invoked asynchronously by the chat
    // handler, so failed events (after retries) land here instead of being lost.
    const deadLetterQueue = new sqs.Queue(this, 'EscalationRouterDLQ', {
      queueName: 'GCC-EscalationRouter-DLQ',
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      retentionPeriod: cdk.Duration.days(14),
    });

    // Lambda that processes escalations and alerts staff (Python 3.13, boto3)
    this.function = new lambda.Function(this, 'EscalationRouterFn', {
      functionName: 'GCC-EscalationRouter',
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../../lambda/escalation-router')),
      timeout: cdk.Duration.seconds(15),
      memorySize: 256,
      environment: {
        SNS_TOPIC_ARN: props.staffAlertTopic.topicArn,
        STAFF_EMAIL: CONFIG.STAFF_EMAIL,
        ANALYTICS_TABLE: props.analyticsLogsTable.tableName,
      },
      deadLetterQueue,
      // Escalation alerts reference the volunteer's question/answer, so bound
      // how long those logs are retained.
      logGroup: new logs.LogGroup(this, 'EscalationRouterLogs', {
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });

    // Permission: publish to SNS staff alerts topic
    props.staffAlertTopic.grantPublish(this.function);

    // Permission: write escalation logs to AnalyticsLogs table
    props.analyticsLogsTable.grantWriteData(this.function);

    // Permission: send emails via SES
    this.function.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ses:SendEmail', 'ses:SendRawEmail'],
      resources: ['*'], // SES needs * for sending, email identity verified separately
    }));
  }
}
