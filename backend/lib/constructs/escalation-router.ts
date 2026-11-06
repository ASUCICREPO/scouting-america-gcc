import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import { CONFIG, PREFIX } from '../config/environment';
import * as path from 'path';

export interface EscalationRouterProps {
  // DynamoDB table to log escalation events
  analyticsLogsTable: dynamodb.ITable;
  // Admin dashboard URL linked from alert emails
  dashboardUrl: string;
}

export class EscalationRouter extends Construct {
  public readonly function: lambda.Function;
  public readonly processingQueue: sqs.Queue;
  public readonly deadLetterQueue: sqs.Queue;

  constructor(scope: Construct, id: string, props: EscalationRouterProps) {
    super(scope, id);

    this.deadLetterQueue = new sqs.Queue(this, 'EscalationRouterDLQ', {
      queueName: `${PREFIX}GCC-EscalationRouter-DLQ`,
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      retentionPeriod: cdk.Duration.days(14),
    });
    this.processingQueue = new sqs.Queue(this, 'EscalationRouterQueue', {
      queueName: `${PREFIX}GCC-EscalationRouter-Queue`,
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      retentionPeriod: cdk.Duration.days(14),
      visibilityTimeout: cdk.Duration.minutes(2),
      deadLetterQueue: {
        queue: this.deadLetterQueue,
        maxReceiveCount: 3,
      },
    });

    // Lambda that processes escalations and alerts staff (Python 3.13, boto3)
    this.function = new lambda.Function(this, 'EscalationRouterFn', {
      functionName: `${PREFIX}GCC-EscalationRouter`,
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../../lambda/escalation-router')),
      timeout: cdk.Duration.seconds(15),
      memorySize: 256,
      environment: {
        STAFF_EMAIL: CONFIG.STAFF_EMAIL,
        ANALYTICS_TABLE: props.analyticsLogsTable.tableName,
        DASHBOARD_URL: props.dashboardUrl,
      },
      // Escalation alerts reference the volunteer's question/answer, so bound
      // how long those logs are retained.
      logGroup: new logs.LogGroup(this, 'EscalationRouterLogs', {
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });
    this.function.addEventSource(new sources.SqsEventSource(this.processingQueue, {
      batchSize: 1,
      maxConcurrency: 2,
    }));

    // Delivery state is read and updated on retries so a sent email is not
    // repeated when the message is redelivered.
    props.analyticsLogsTable.grantReadWriteData(this.function);

    // Permission: send emails via SES
    this.function.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ses:SendEmail', 'ses:SendRawEmail'],
      resources: ['*'], // SES needs * for sending, email identity verified separately
    }));

    // Ask SES to verify the staff inbox so alert emails can be sent from and to
    // it. SES emails a verification link; re-running for a verified address is
    // harmless. Deleting the stack leaves the identity in place.
    if (CONFIG.STAFF_EMAIL) {
      const verifyStaffEmail: cr.AwsSdkCall = {
        service: 'SES',
        action: 'VerifyEmailIdentity',
        parameters: { EmailAddress: CONFIG.STAFF_EMAIL },
        physicalResourceId: cr.PhysicalResourceId.of(`ses-identity-${CONFIG.STAFF_EMAIL}`),
      };
      new cr.AwsCustomResource(this, 'VerifyStaffEmail', {
        onCreate: verifyStaffEmail,
        onUpdate: verifyStaffEmail,
        policy: cr.AwsCustomResourcePolicy.fromStatements([
          new iam.PolicyStatement({
            actions: ['ses:VerifyEmailIdentity'],
            resources: ['*'],
          }),
        ]),
        installLatestAwsSdk: false,
      });
    }
  }
}
