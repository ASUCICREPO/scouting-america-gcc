import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export interface AdminHandlerProps {
  documentStoreBucket: s3.IBucket;
  knowledgeBaseBucket: s3.IBucket;
  guardrailsSecret: secretsmanager.ISecret;
  userPool: cognito.IUserPool;
}

export class AdminHandler extends Construct {
  public readonly api: apigateway.RestApi;
  public readonly lambdaFunction: lambda.Function;

  constructor(scope: Construct, id: string, props: AdminHandlerProps) {
    super(scope, id);

    const { documentStoreBucket, knowledgeBaseBucket, guardrailsSecret, userPool } = props;

    // ---------------------------------------------------------------
    // Lambda Function
    // ---------------------------------------------------------------
    this.lambdaFunction = new nodejs.NodejsFunction(this, 'AdminHandlerFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '../../lambda/admin-handler/index.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {
        DOCUMENT_STORE_BUCKET: documentStoreBucket.bucketName,
        KNOWLEDGE_BASE_BUCKET: knowledgeBaseBucket.bucketName,
        GUARDRAILS_SECRET_ARN: guardrailsSecret.secretArn,
      },
      bundling: {
        minify: true,
        sourceMap: true,
      },
    });

    // ---------------------------------------------------------------
    // IAM Permissions
    // ---------------------------------------------------------------
    documentStoreBucket.grantReadWrite(this.lambdaFunction);
    knowledgeBaseBucket.grantReadWrite(this.lambdaFunction);
    guardrailsSecret.grantRead(this.lambdaFunction);
    guardrailsSecret.grantWrite(this.lambdaFunction);

    // s3:ListBucket permission on both buckets
    this.lambdaFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['s3:ListBucket'],
      resources: [
        documentStoreBucket.bucketArn,
        knowledgeBaseBucket.bucketArn,
      ],
    }));

    // ---------------------------------------------------------------
    // API Gateway REST API
    // ---------------------------------------------------------------
    this.api = new apigateway.RestApi(this, 'AdminApi', {
      restApiName: 'GCC Admin API',
      description: 'Admin REST API for GCC Volunteer Support Assistant',
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: ['Content-Type', 'Authorization'],
      },
    });

    // Cognito Authorizer
    const cognitoAuthorizer = new apigateway.CognitoUserPoolsAuthorizer(this, 'AdminCognitoAuthorizer', {
      cognitoUserPools: [userPool],
      authorizerName: 'AdminCognitoAuthorizer',
    });

    const lambdaIntegration = new apigateway.LambdaIntegration(this.lambdaFunction);

    const authMethodOptions: apigateway.MethodOptions = {
      authorizer: cognitoAuthorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    };

    // ---------------------------------------------------------------
    // Resource Routes
    // ---------------------------------------------------------------

    // /admin
    const adminResource = this.api.root.addResource('admin');

    // /admin/documents
    const documentsResource = adminResource.addResource('documents');
    documentsResource.addMethod('POST', lambdaIntegration, authMethodOptions);
    documentsResource.addMethod('GET', lambdaIntegration, authMethodOptions);

    // /admin/documents/{id}
    const documentByIdResource = documentsResource.addResource('{id}');
    documentByIdResource.addMethod('PUT', lambdaIntegration, authMethodOptions);
    documentByIdResource.addMethod('DELETE', lambdaIntegration, authMethodOptions);

    // /admin/guardrails
    const guardrailsResource = adminResource.addResource('guardrails');
    guardrailsResource.addMethod('PUT', lambdaIntegration, authMethodOptions);
    guardrailsResource.addMethod('GET', lambdaIntegration, authMethodOptions);
  }
}
