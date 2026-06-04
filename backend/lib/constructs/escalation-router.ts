import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as iam from 'aws-cdk-lib/aws-iam';
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

    // Lambda that processes escalations and alerts staff
    this.function = new nodejs.NodejsFunction(this, 'EscalationRouterFn', {
      functionName: 'GCC-EscalationRouter',
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '../../lambda/escalation-router/index.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(15),
      memorySize: 256,
      environment: {
        SNS_TOPIC_ARN: props.staffAlertTopic.topicArn,
        STAFF_EMAIL: CONFIG.STAFF_EMAIL,
        ANALYTICS_TABLE: props.analyticsLogsTable.tableName,
      },
      bundling: {
        minify: true,
        sourceMap: true,
      },
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
