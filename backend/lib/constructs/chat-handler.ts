import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import { Construct } from 'constructs';
import { CONFIG } from '../config/environment';
import * as path from 'path';

export interface ChatHandlerProps {
  // DynamoDB table where we store conversations
  chatLogsTable: dynamodb.ITable;
  // Secrets Manager secret with system guardrails
  guardrailsSecret: secretsmanager.ISecret;
  // API Gateway resources to attach routes to
  chatResource: apigateway.Resource;
  chatHistoryResource: apigateway.Resource;
  // Cognito authorizer for protecting routes
  authorizer: apigateway.IAuthorizer;
  // Knowledge Base ID — we'll get this from the KB construct
  knowledgeBaseId: string;
  // Escalation Router Lambda ARN — wire after creating escalation construct
  escalationFunctionArn?: string;
}

export class ChatHandler extends Construct {
  public readonly function: lambda.Function;

  constructor(scope: Construct, id: string, props: ChatHandlerProps) {
    super(scope, id);

    // The Lambda function that handles volunteer chat requests
    this.function = new nodejs.NodejsFunction(this, 'ChatHandlerFn', {
      functionName: 'GCC-ChatHandler',
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '../../lambda/chat-handler/index.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(30), // Bedrock calls can take a few seconds
      memorySize: 512,
      environment: {
        KB_ID: props.knowledgeBaseId,
        MODEL_ARN: `arn:aws:bedrock:us-east-1::foundation-model/${CONFIG.MODEL_ID}`,
        CHAT_LOGS_TABLE: props.chatLogsTable.tableName,
        SECRETS_ARN: props.guardrailsSecret.secretArn,
        ESCALATION_FUNCTION_ARN: props.escalationFunctionArn || '',
        CONFIDENCE_THRESHOLD: CONFIG.CONFIDENCE_THRESHOLD.toString(),
        SAFETY_KEYWORDS: JSON.stringify(CONFIG.SAFETY_KEYWORDS),
      },
      bundling: {
        minify: true,
        sourceMap: true,
      },
    });

    // Grant permissions: read/write to ChatLogs table
    props.chatLogsTable.grantReadWriteData(this.function);

    // Grant permissions: read guardrails from Secrets Manager
    props.guardrailsSecret.grantRead(this.function);

    // Grant permissions: call Bedrock KB RetrieveAndGenerate
    this.function.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'bedrock:RetrieveAndGenerate',
        'bedrock:Retrieve',
      ],
      resources: ['*'], // KB resources are account-wide
    }));

    // Grant permissions: invoke Escalation Router Lambda
    if (props.escalationFunctionArn) {
      this.function.addToRolePolicy(new iam.PolicyStatement({
        actions: ['lambda:InvokeFunction'],
        resources: [props.escalationFunctionArn],
      }));
    }

    // Connect to API Gateway: POST /chat
    props.chatResource.addMethod('POST', new apigateway.LambdaIntegration(this.function), {
      authorizer: props.authorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });

    // Connect to API Gateway: GET /chat/history/{sessionId}
    props.chatHistoryResource.addMethod('GET', new apigateway.LambdaIntegration(this.function), {
      authorizer: props.authorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });
  }
}
