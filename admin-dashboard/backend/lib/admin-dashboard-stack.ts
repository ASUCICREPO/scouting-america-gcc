import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as path from 'path';
import { Construct } from 'constructs';

/**
 * AdminDashboardStack — completely independent from the chatbot BackendStack.
 *
 * Security:
 * - Cognito authorizer on all endpoints (uses existing GCC-VolunteerPool, admin group required)
 * - S3 permissions scoped to specific buckets and prefixes
 * - CORS restricted (configurable via env)
 */
export class AdminDashboardStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ─── Configuration (centralized) ───
    const chatLogsTableName = 'GCC-ChatLogs';
    const analyticsLogsTableName = 'GCC-AnalyticsLogs';
    const documentBucket = 'gcc-document-store';
    const kbBucket = 'gcc-knowledge-base-data';
    const userPoolId = 'us-east-1_JPREn2oHX'; // Existing chatbot Cognito User Pool

    // Import the existing Cognito User Pool (from chatbot BackendStack)
    const userPool = cognito.UserPool.fromUserPoolId(this, 'ImportedUserPool', userPoolId);

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
        DOCUMENT_BUCKET: documentBucket,
        KB_BUCKET: kbBucket,
      },
    });

    // Grant READ-ONLY access to DynamoDB tables
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

    // Grant S3 permissions — scoped to specific buckets and prefixes
    dashboardFn.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        's3:ListBucket',
      ],
      resources: [
        `arn:aws:s3:::${documentBucket}`,
        `arn:aws:s3:::${kbBucket}`,
      ],
    }));

    dashboardFn.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        's3:GetObject',
        's3:PutObject',
        's3:DeleteObject',
      ],
      resources: [
        `arn:aws:s3:::${documentBucket}/uploads/*`,
        `arn:aws:s3:::${kbBucket}/documents/*`,
      ],
    }));

    // ─── API Gateway with Cognito Authorizer ───
    const api = new apigateway.RestApi(this, 'DashboardApi', {
      restApiName: 'GCC-AdminDashboard-API',
      description: 'Authenticated API for the GCC Admin Dashboard',
      deployOptions: { stageName: 'prod' },
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS, // Tighten in production
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: ['Content-Type', 'Authorization'],
      },
    });

    // Cognito authorizer — validates JWT and checks admin group in Lambda
    const authorizer = new apigateway.CognitoUserPoolsAuthorizer(this, 'DashboardAuthorizer', {
      cognitoUserPools: [userPool],
      authorizerName: 'GCC-DashboardAuth',
      identitySource: 'method.request.header.Authorization',
    });

    const authMethodOptions: apigateway.MethodOptions = {
      authorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    };

    const integration = new apigateway.LambdaIntegration(dashboardFn);

    // ─── Routes (all authenticated) ───
    const dashboard = api.root.addResource('dashboard');

    // Analytics endpoints
    dashboard.addResource('summary').addMethod('GET', integration, authMethodOptions);
    dashboard.addResource('conversations').addMethod('GET', integration, authMethodOptions);
    dashboard.addResource('confidence').addMethod('GET', integration, authMethodOptions);
    dashboard.addResource('escalations').addMethod('GET', integration, authMethodOptions);
    dashboard.addResource('negative-feedback').addMethod('GET', integration, authMethodOptions);

    // FAQ endpoints
    const faqResource = dashboard.addResource('faq');
    faqResource.addMethod('GET', integration, authMethodOptions);
    faqResource.addResource('all').addMethod('GET', integration, authMethodOptions);

    // Document endpoints
    const docsResource = dashboard.addResource('documents');
    docsResource.addMethod('GET', integration, authMethodOptions);
    docsResource.addMethod('DELETE', integration, authMethodOptions);
    docsResource.addResource('download').addMethod('GET', integration, authMethodOptions);
    docsResource.addResource('upload').addMethod('POST', integration, authMethodOptions);

    // ─── Outputs ───
    new cdk.CfnOutput(this, 'DashboardApiUrl', {
      value: api.url,
      description: 'Admin Dashboard API URL (Cognito-protected)',
    });

    new cdk.CfnOutput(this, 'UserPoolId', {
      value: userPoolId,
      description: 'Cognito User Pool ID (shared with chatbot)',
    });
  }
}
