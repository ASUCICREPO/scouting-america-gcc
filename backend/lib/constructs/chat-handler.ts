import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { CONFIG, PREFIX } from '../config/environment';
import * as path from 'path';

export interface ChatHandlerProps {
  // DynamoDB table where we store conversations
  chatLogsTable: dynamodb.ITable;
  dependenciesLayer: lambda.ILayerVersion;
  guardrailId: string;
  guardrailVersion: string;
  promptAttackGuardrailId: string;
  promptAttackGuardrailVersion: string;
  promptId: string;
  promptVersion: string;
  allowedOrigin: string;
  // API Gateway resources to attach routes to
  chatResource: apigateway.Resource;
  chatHistoryResource: apigateway.Resource;
  chatFeedbackResource: apigateway.Resource;
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
    // (Python 3.13; boto3 comes from the runtime, app dependencies from a layer).
    this.function = new lambda.Function(this, 'ChatHandlerFn', {
      functionName: `${PREFIX}GCC-ChatHandler`,
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../../lambda/chat-handler')),
      timeout: cdk.Duration.seconds(30), // Bedrock calls can take a few seconds
      memorySize: 512,
      layers: [props.dependenciesLayer],
      environment: {
        KB_ID: props.knowledgeBaseId,
        MODEL_ARN: `arn:aws:bedrock:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:inference-profile/${CONFIG.MODEL_ID}`,
        CHAT_LOGS_TABLE: props.chatLogsTable.tableName,
        GUARDRAIL_ID: props.guardrailId,
        GUARDRAIL_VERSION: props.guardrailVersion,
        PROMPT_ATTACK_GUARDRAIL_ID: props.promptAttackGuardrailId,
        PROMPT_ATTACK_GUARDRAIL_VERSION: props.promptAttackGuardrailVersion,
        PROMPT_ID: props.promptId,
        PROMPT_VERSION: props.promptVersion,
        ALLOWED_ORIGIN: props.allowedOrigin,
        ESCALATION_FUNCTION_ARN: props.escalationFunctionArn || '',
        CONFIDENCE_THRESHOLD: CONFIG.CONFIDENCE_THRESHOLD.toString(),
        SAFETY_KEYWORDS: JSON.stringify(CONFIG.SAFETY_KEYWORDS),
      },
      // Bound log retention — chat logs may incidentally contain user-entered
      // content, so they shouldn't be kept indefinitely.
      logGroup: new logs.LogGroup(this, 'ChatHandlerLogs', {
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });

    // Grant permissions: read/write to ChatLogs table
    props.chatLogsTable.grantReadWriteData(this.function);

    // Grant permissions: retrieve once from the KB, generate from those exact
    // sources, and read the immutable Prompt Management version.
    this.function.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'bedrock:Retrieve',
        'bedrock:InvokeModel',
        'bedrock:ApplyGuardrail',
        'bedrock:GetInferenceProfile',
        'bedrock:GetPrompt',
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

    // Connect to API Gateway: POST /chat (no auth — public endpoint)
    props.chatResource.addMethod('POST', new apigateway.LambdaIntegration(this.function), {
      authorizationType: apigateway.AuthorizationType.NONE,
    });

    // Connect to API Gateway: GET /chat/history/{sessionId} (no auth — public endpoint)
    props.chatHistoryResource.addMethod('GET', new apigateway.LambdaIntegration(this.function), {
      authorizationType: apigateway.AuthorizationType.NONE,
    });

    // Connect to API Gateway: POST /chat/feedback (no auth — public endpoint)
    props.chatFeedbackResource.addMethod('POST', new apigateway.LambdaIntegration(this.function), {
      authorizationType: apigateway.AuthorizationType.NONE,
    });
  }
}
