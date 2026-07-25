import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import * as path from 'path';
import { PREFIX } from '../config/environment';

export interface DashboardApiProps {
  /** ChatLogs table (read-only) — powers usage/faq/confidence/feedback metrics */
  chatLogsTable: dynamodb.ITable;
  /** AnalyticsLogs table (read-only) — powers escalation/document metrics */
  analyticsLogsTable: dynamodb.ITable;
  /** Document store bucket — list/download/upload/delete under uploads/ */
  documentStoreBucket: s3.IBucket;
  /** Knowledge base bucket — delete the ingested copy under documents/ */
  knowledgeBaseBucket: s3.IBucket;
  /** Existing Cognito user pool — authorizer validates admin group */
  userPool: cognito.IUserPool;
  /** Bedrock KB id + data source id — re-sync ingestion after a delete */
  knowledgeBaseId: string;
  dataSourceId: string;
  allowedOrigin: string;
  dependenciesLayer: lambda.ILayerVersion;
}

/**
 * DashboardApi — the single admin/analytics + document-management API.
 *
 * Consolidated into the main backend (replaces the former standalone
 * admin-dashboard CDK app and the unused analytics/admin-handler lambdas).
 * All routes are Cognito-authenticated; the Lambda re-checks the admin group.
 */
export class DashboardApi extends Construct {
  public readonly api: apigateway.RestApi;
  public readonly function: lambda.Function;

  constructor(scope: Construct, id: string, props: DashboardApiProps) {
    super(scope, id);

    // ─── Lambda (Python 3.13, boto3 in the runtime — no bundling) ───
    this.function = new lambda.Function(this, 'DashboardFunction', {
      functionName: `${PREFIX}GCC-AdminDashboard`,
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../../lambda/dashboard')),
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      layers: [props.dependenciesLayer],
      environment: {
        CHAT_LOGS_TABLE: props.chatLogsTable.tableName,
        ANALYTICS_LOGS_TABLE: props.analyticsLogsTable.tableName,
        DOCUMENT_BUCKET: props.documentStoreBucket.bucketName,
        KB_BUCKET: props.knowledgeBaseBucket.bucketName,
        KNOWLEDGE_BASE_ID: props.knowledgeBaseId,
        DATA_SOURCE_ID: props.dataSourceId,
        ALLOWED_ORIGIN: props.allowedOrigin,
      },
      logGroup: new logs.LogGroup(this, 'DashboardLogs', {
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });

    // ─── IAM (scoped to shared resources by reference — no hardcoded ARNs) ───
    props.chatLogsTable.grantReadData(this.function);
    props.analyticsLogsTable.grantReadData(this.function);

    this.function.addToRolePolicy(new iam.PolicyStatement({
      actions: ['s3:ListBucket'],
      resources: [props.documentStoreBucket.bucketArn, props.knowledgeBaseBucket.bucketArn],
    }));
    this.function.addToRolePolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
      resources: [`${props.documentStoreBucket.bucketArn}/uploads/*`],
    }));
    this.function.addToRolePolicy(new iam.PolicyStatement({
      actions: ['s3:DeleteObject'],
      resources: [`${props.knowledgeBaseBucket.bucketArn}/documents/*`],
    }));
    this.function.addToRolePolicy(new iam.PolicyStatement({
      actions: ['bedrock:StartIngestionJob', 'bedrock:ListIngestionJobs', 'bedrock:GetIngestionJob'],
      resources: [`arn:aws:bedrock:*:*:knowledge-base/${props.knowledgeBaseId}`],
    }));

    // ─── API Gateway (Cognito-authenticated, throttled) ───
    this.api = new apigateway.RestApi(this, 'DashboardApi', {
      restApiName: 'GCC-AdminDashboard-API',
      description: 'Authenticated API for the GCC Admin Dashboard',
      deployOptions: {
        stageName: 'prod',
        throttlingRateLimit: 50,
        throttlingBurstLimit: 100,
      },
      defaultCorsPreflightOptions: {
        allowOrigins: [props.allowedOrigin],
        allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
        allowHeaders: ['Content-Type', 'Authorization'],
      },
    });

    const authorizer = new apigateway.CognitoUserPoolsAuthorizer(this, 'DashboardAuthorizer', {
      cognitoUserPools: [props.userPool],
      authorizerName: 'GCC-DashboardAuth',
      identitySource: 'method.request.header.Authorization',
    });

    const authMethodOptions: apigateway.MethodOptions = {
      authorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    };

    const integration = new apigateway.LambdaIntegration(this.function);

    // ─── Routes ───
    const dashboard = this.api.root.addResource('dashboard');
    dashboard.addResource('summary').addMethod('GET', integration, authMethodOptions);
    dashboard.addResource('conversations').addMethod('GET', integration, authMethodOptions);
    dashboard.addResource('confidence').addMethod('GET', integration, authMethodOptions);
    dashboard.addResource('escalations').addMethod('GET', integration, authMethodOptions);
    dashboard.addResource('negative-feedback').addMethod('GET', integration, authMethodOptions);
    dashboard.addResource('feedback').addMethod('GET', integration, authMethodOptions);
    dashboard.addResource('session').addMethod('GET', integration, authMethodOptions);

    const faq = dashboard.addResource('faq');
    faq.addMethod('GET', integration, authMethodOptions);
    faq.addResource('all').addMethod('GET', integration, authMethodOptions);

    const documents = dashboard.addResource('documents');
    documents.addMethod('GET', integration, authMethodOptions);
    documents.addMethod('DELETE', integration, authMethodOptions);
    documents.addResource('download').addMethod('GET', integration, authMethodOptions);
    documents.addResource('upload').addMethod('POST', integration, authMethodOptions);
  }
}
