import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as path from 'path';
import { Construct } from 'constructs';

/**
 * AdminDashboardStack — completely independent from the chatbot BackendStack.
 * 
 * This stack creates:
 * - A Lambda that reads (read-only) from the chatbot's existing DynamoDB tables
 * - An API Gateway to expose dashboard endpoints
 * 
 * It does NOT modify, create, or delete any resources in the chatbot stack.
 */
export class AdminDashboardStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Reference existing table names from the chatbot's BackendStack
    const chatLogsTableName = 'GCC-ChatLogs';
    const analyticsLogsTableName = 'GCC-AnalyticsLogs';

    // ─── Lambda Function ───
    const dashboardFn = new lambda.Function(this, 'DashboardFunction', {
      functionName: 'GCC-AdminDashboard',
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda')),
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      environment: {
        CHAT_LOGS_TABLE: chatLogsTableName,
        ANALYTICS_LOGS_TABLE: analyticsLogsTableName,
      },
    });

    // Grant READ-ONLY access to the chatbot's DynamoDB tables
    // This does NOT modify those tables — just allows this Lambda to read them
    dashboardFn.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'dynamodb:Scan',
        'dynamodb:Query',
        'dynamodb:GetItem',
        'dynamodb:BatchGetItem',
      ],
      resources: [
        `arn:aws:dynamodb:us-east-1:${cdk.Aws.ACCOUNT_ID}:table/${chatLogsTableName}`,
        `arn:aws:dynamodb:us-east-1:${cdk.Aws.ACCOUNT_ID}:table/${chatLogsTableName}/index/*`,
        `arn:aws:dynamodb:us-east-1:${cdk.Aws.ACCOUNT_ID}:table/${analyticsLogsTableName}`,
        `arn:aws:dynamodb:us-east-1:${cdk.Aws.ACCOUNT_ID}:table/${analyticsLogsTableName}/index/*`,
      ],
    }));

    // ─── API Gateway ───
    const api = new apigateway.RestApi(this, 'DashboardApi', {
      restApiName: 'GCC-AdminDashboard-API',
      description: 'API for the GCC Admin Dashboard — reads live data from chatbot tables',
      deployOptions: {
        stageName: 'prod',
      },
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: ['Content-Type', 'Authorization'],
      },
    });

    const integration = new apigateway.LambdaIntegration(dashboardFn);

    // Routes
    const dashboard = api.root.addResource('dashboard');
    dashboard.addResource('summary').addMethod('GET', integration);
    dashboard.addResource('conversations').addMethod('GET', integration);
    dashboard.addResource('faq').addMethod('GET', integration);
    dashboard.addResource('confidence').addMethod('GET', integration);
    dashboard.addResource('escalations').addMethod('GET', integration);
    dashboard.addResource('negative-feedback').addMethod('GET', integration);
    dashboard.addResource('documents').addMethod('GET', integration);

    // ─── Outputs ───
    new cdk.CfnOutput(this, 'DashboardApiUrl', {
      value: api.url,
      description: 'Admin Dashboard API URL',
    });
  }
}
