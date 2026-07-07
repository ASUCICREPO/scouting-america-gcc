import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

export interface AnalyticsConstructProps {
  chatLogsTable: dynamodb.ITable;
  analyticsLogsTable: dynamodb.ITable;
  adminApi: apigateway.RestApi;
  cognitoAuthorizer: apigateway.IAuthorizer;
}

export class AnalyticsConstruct extends Construct {
  public readonly analyticsFunction: lambda.Function;

  constructor(scope: Construct, id: string, props: AnalyticsConstructProps) {
    super(scope, id);

    // ---------------------------------------------------------------
    // Analytics Lambda Function
    // ---------------------------------------------------------------
    this.analyticsFunction = new nodejs.NodejsFunction(this, 'AnalyticsFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '../../lambda/analytics/index.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {
        CHAT_LOGS_TABLE: props.chatLogsTable.tableName,
        ANALYTICS_LOGS_TABLE: props.analyticsLogsTable.tableName,
      },
      logGroup: new logs.LogGroup(this, 'AnalyticsLogs', {
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
      bundling: {
        minify: true,
        sourceMap: true,
      },
    });

    // Grant read access to DynamoDB tables
    props.chatLogsTable.grantReadData(this.analyticsFunction);
    props.analyticsLogsTable.grantReadData(this.analyticsFunction);

    // ---------------------------------------------------------------
    // API Gateway Resources
    // ---------------------------------------------------------------

    // Get or create /admin resource
    let adminResource = props.adminApi.root.getResource('admin');
    if (!adminResource) {
      adminResource = props.adminApi.root.addResource('admin');
    }

    // Get or create /admin/analytics resource
    let analyticsResource = adminResource.getResource('analytics');
    if (!analyticsResource) {
      analyticsResource = adminResource.addResource('analytics');
    }

    // Sub-resources: /usage, /categories, /escalations
    const usageResource = analyticsResource.addResource('usage');
    const categoriesResource = analyticsResource.addResource('categories');
    const escalationsResource = analyticsResource.addResource('escalations');

    // Lambda integration
    const lambdaIntegration = new apigateway.LambdaIntegration(this.analyticsFunction);

    const methodOptions: apigateway.MethodOptions = {
      authorizer: props.cognitoAuthorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    };

    // Add GET methods with Cognito authorizer
    usageResource.addMethod('GET', lambdaIntegration, methodOptions);
    categoriesResource.addMethod('GET', lambdaIntegration, methodOptions);
    escalationsResource.addMethod('GET', lambdaIntegration, methodOptions);
  }
}
