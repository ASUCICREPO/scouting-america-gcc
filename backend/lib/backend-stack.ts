import * as cdk from 'aws-cdk-lib';
import { Aspects } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { AwsSolutionsChecks, NagSuppressions } from 'cdk-nag';
import { SharedResources } from './constructs/shared-resources';
import { ApiGateway } from './constructs/api-gateway';
import { KnowledgeBase } from './constructs/knowledge-base';
import { EscalationRouter } from './constructs/escalation-router';
import { ChatHandler } from './constructs/chat-handler';
import { DocProcessor } from './constructs/doc-processor';
import { DashboardApi } from './constructs/dashboard-api';
import { FrontendHosting } from './constructs/frontend-hosting';
import { AiSafety } from './constructs/ai-safety';
import { PythonDependencies } from './constructs/python-dependencies';
import { ChatArchive } from './constructs/chat-archive';
import { Observability } from './constructs/observability';

export class GrandCanyonCouncilChatbot extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ADR: cdk-nag scoped to stack, not app entry point
    // Rationale: Self-contained security checks travel with the stack when used as a template
    // Alternative: Aspects.of(app) in bin/backend.ts (rejected - doesn't travel with stack)
    Aspects.of(this).add(new AwsSolutionsChecks({ verbose: true }));

    const frontendHosting = new FrontendHosting(this, 'FrontendHosting');
    const frontendOrigin = `https://${frontendHosting.distribution.distributionDomainName}`;

    // ---------------------------------------------------------------
    // Shared Resources (S3, DynamoDB, Cognito, SNS)
    // ---------------------------------------------------------------
    const sharedResources = new SharedResources(this, 'SharedResources', {
      allowedOrigin: frontendOrigin,
    });

    // ---------------------------------------------------------------
    // Knowledge Base (Bedrock KB + S3 data source + Titan embeddings)
    // ---------------------------------------------------------------
    const knowledgeBase = new KnowledgeBase(this, 'KnowledgeBase', {
      knowledgeBaseBucket: sharedResources.knowledgeBaseBucket,
    });

    const pythonDependencies = new PythonDependencies(this, 'PythonDependencies');
    const aiSafety = new AiSafety(this, 'AiSafety');

    // ---------------------------------------------------------------
    // Escalation Router (alerts staff when safety/low-confidence detected)
    // ---------------------------------------------------------------
    const escalationRouter = new EscalationRouter(this, 'EscalationRouter', {
      staffAlertTopic: sharedResources.staffAlertTopic,
      analyticsLogsTable: sharedResources.analyticsLogsTable,
    });

    // ---------------------------------------------------------------
    // API Gateway (REST API with Cognito auth — the front door)
    // ---------------------------------------------------------------
    const apiGateway = new ApiGateway(this, 'ApiGateway', {
      allowedOrigin: frontendOrigin,
    });

    // ---------------------------------------------------------------
    // Chat Handler (processes volunteer questions via Bedrock KB)
    // ---------------------------------------------------------------
    const chatHandler = new ChatHandler(this, 'ChatHandler', {
      chatLogsTable: sharedResources.chatLogsTable,
      dependenciesLayer: pythonDependencies.layer,
      guardrailId: aiSafety.guardrailId,
      guardrailVersion: aiSafety.guardrailVersion,
      promptAttackGuardrailId: aiSafety.promptAttackGuardrailId,
      promptAttackGuardrailVersion: aiSafety.promptAttackGuardrailVersion,
      promptId: aiSafety.promptId,
      promptVersion: aiSafety.promptVersion,
      allowedOrigin: frontendOrigin,
      chatResource: apiGateway.chatResource,
      chatHistoryResource: apiGateway.chatHistoryResource,
      chatFeedbackResource: apiGateway.chatFeedbackResource,
      knowledgeBaseId: knowledgeBase.knowledgeBaseId,
      escalationQueue: escalationRouter.processingQueue,
    });

    // ---------------------------------------------------------------
    // Doc Processor Lambda
    // ---------------------------------------------------------------
    const docProcessor = new DocProcessor(this, 'DocProcessor', {
      documentStoreBucket: sharedResources.documentStoreBucket,
      knowledgeBaseBucket: sharedResources.knowledgeBaseBucket,
      analyticsTable: sharedResources.analyticsLogsTable,
      knowledgeBaseId: knowledgeBase.knowledgeBaseId,
      dataSourceId: knowledgeBase.dataSourceId,
    });

    // Buffer uploads in SQS; the worker consumes one at a time so document
    // processing cannot exhaust account Lambda concurrency.
    sharedResources.documentStoreBucket.addEventNotification(
      cdk.aws_s3.EventType.OBJECT_CREATED,
      new cdk.aws_s3_notifications.SqsDestination(docProcessor.processingQueue),
      { prefix: 'uploads/' },
    );

    const chatArchive = new ChatArchive(this, 'ChatArchive', {
      chatLogsTable: sharedResources.chatLogsTable,
      archiveBucket: sharedResources.chatArchiveBucket,
    });

    // ---------------------------------------------------------------
    // Admin Dashboard API (metrics + document management, Cognito-authed)
    // Consolidated single admin surface — replaces the former standalone
    // admin-dashboard CDK app and the unused analytics/admin-handler lambdas.
    // ---------------------------------------------------------------
    const dashboardApi = new DashboardApi(this, 'DashboardApi', {
      chatLogsTable: sharedResources.chatLogsTable,
      analyticsLogsTable: sharedResources.analyticsLogsTable,
      documentStoreBucket: sharedResources.documentStoreBucket,
      knowledgeBaseBucket: sharedResources.knowledgeBaseBucket,
      userPool: sharedResources.userPool,
      knowledgeBaseId: knowledgeBase.knowledgeBaseId,
      dataSourceId: knowledgeBase.dataSourceId,
      allowedOrigin: frontendOrigin,
      dependenciesLayer: pythonDependencies.layer,
    });

    const observability = new Observability(this, 'Observability', {
      alertTopic: sharedResources.staffAlertTopic,
      functions: [
        chatHandler.function,
        dashboardApi.function,
        docProcessor.function,
        escalationRouter.function,
        chatArchive.function,
      ],
      deadLetterQueues: [
        docProcessor.deadLetterQueue,
        escalationRouter.deadLetterQueue,
        chatArchive.deadLetterQueue,
      ],
      documentQueue: docProcessor.processingQueue,
    });

    // ---------------------------------------------------------------
    // Stack Outputs
    // ---------------------------------------------------------------
    new cdk.CfnOutput(this, 'ChatApiUrl', {
      value: apiGateway.api.url,
      description: 'Public chat API URL (POST /chat, GET /chat/history/{sessionId})',
    });

    new cdk.CfnOutput(this, 'DashboardApiUrl', {
      value: dashboardApi.api.url,
      description: 'Admin Dashboard API URL (Cognito-protected)',
    });

    new cdk.CfnOutput(this, 'UserPoolId', {
      value: sharedResources.userPool.userPoolId,
      description: 'Cognito User Pool ID',
    });

    new cdk.CfnOutput(this, 'UserPoolClientId', {
      value: sharedResources.userPoolClient.userPoolClientId,
      description: 'Cognito User Pool Client ID',
    });

    new cdk.CfnOutput(this, 'DocumentStoreBucket', {
      value: sharedResources.documentStoreBucket.bucketName,
      description: 'S3 Bucket for document uploads',
    });

    new cdk.CfnOutput(this, 'KnowledgeBaseBucket', {
      value: sharedResources.knowledgeBaseBucket.bucketName,
      description: 'S3 Bucket for KB processed chunks',
    });

    new cdk.CfnOutput(this, 'ChatArchiveBucket', {
      value: sharedResources.chatArchiveBucket.bucketName,
      description: 'Object-locked S3 archive of delivered chat turns',
    });

    new cdk.CfnOutput(this, 'FrontendBucket', {
      value: frontendHosting.siteBucket.bucketName,
      description: 'S3 bucket for the complete frontend static export',
    });

    new cdk.CfnOutput(this, 'FrontendDistributionId', {
      value: frontendHosting.distribution.distributionId,
      description: 'CloudFront distribution ID for the frontend',
    });

    new cdk.CfnOutput(this, 'FrontendUrl', {
      value: frontendOrigin,
      description: 'Frontend URL (public chat at /, admin login at /admin)',
    });

    new cdk.CfnOutput(this, 'OperationsDashboardName', {
      value: observability.dashboard.dashboardName,
      description: 'CloudWatch dashboard for Lambda, ingestion queue, and DLQ health',
    });

    // ---------------------------------------------------------------
    // cdk-nag suppressions
    // ---------------------------------------------------------------
    NagSuppressions.addStackSuppressions(this, [
      {
        id: 'AwsSolutions-S1',
        reason: 'ADR: S3 access logging deferred | Rationale: POC phase, will enable for production | Alternative: Enable now (rejected - adds cost during development)',
      },
      {
        id: 'AwsSolutions-COG2',
        reason: 'ADR: MFA not required for POC | Rationale: Volunteer usability priority during pilot | Alternative: Require MFA (will enable for production rollout)',
      },
      {
        id: 'AwsSolutions-COG3',
        reason: 'ADR: Advanced security disabled for POC | Rationale: Cost optimization during pilot phase | Alternative: Enable (will add for production)',
      },
      {
        id: 'AwsSolutions-COG8',
        reason: 'ADR: Plus tier not enabled for POC | Rationale: Cost optimization, nonprofit budget constraints | Alternative: Enable Plus tier (will evaluate for production)',
      },
      {
        id: 'AwsSolutions-SQS3',
        reason: 'ADR: DLQ queues are themselves dead-letter queues | Rationale: The escalation-router and doc-processor queues capture failed async invocations; a DLQ for a DLQ is unnecessary | Alternative: N/A',
      },
      {
        id: 'AwsSolutions-SNS2',
        reason: 'ADR: SNS encryption deferred | Rationale: Non-sensitive alert metadata only | Alternative: KMS encryption (will add if PII flows through topic)',
      },
      {
        id: 'AwsSolutions-SNS3',
        reason: 'ADR: SNS SSL enforcement deferred | Rationale: POC phase, subscribers are AWS services | Alternative: Require SSL (will add for production)',
      },
      {
        id: 'AwsSolutions-IAM4',
        reason: 'ADR: AWS managed policies used for Lambda basic execution | Rationale: Standard practice for Lambda logging | Alternative: Custom policy (unnecessary overhead)',
      },
      {
        id: 'AwsSolutions-IAM5',
        reason: 'ADR: Wildcard permissions for Bedrock KB and scoped S3 object actions | Rationale: KB resources are account-scoped (ARN not known at synth time); S3 actions are scoped to specific buckets | Alternative: Narrow after deployment (impractical for dynamic uploads)',
      },
      {
        id: 'AwsSolutions-APIG1',
        reason: 'ADR: API Gateway access logging deferred | Rationale: POC phase, CloudWatch Lambda logs sufficient | Alternative: Enable (will add for production)',
      },
      {
        id: 'AwsSolutions-APIG2',
        reason: 'ADR: API Gateway request validation deferred | Rationale: Lambda handles validation | Alternative: Add request validator models (will add for production)',
      },
      {
        id: 'AwsSolutions-APIG3',
        reason: 'ADR: WAF not attached to API Gateway | Rationale: POC phase, cost optimization | Alternative: Attach WAF (will add for production)',
      },
      {
        id: 'AwsSolutions-APIG4',
        reason: 'ADR: OPTIONS method without auth for CORS | Rationale: CORS preflight requests cannot carry auth tokens | Alternative: N/A (browser limitation)',
      },
      {
        id: 'AwsSolutions-APIG6',
        reason: 'ADR: CloudWatch stage logging deferred | Rationale: POC phase, Lambda-level logging sufficient | Alternative: Enable stage logging (will add for production)',
      },
      {
        id: 'AwsSolutions-COG4',
        reason: 'ADR: Cognito authorizer on OPTIONS not possible | Rationale: CORS preflight requests cannot carry auth tokens | Alternative: N/A (browser spec requirement)',
      },
      {
        id: 'AwsSolutions-L1',
        reason: 'ADR: Lambdas run on Python 3.13 (latest runtime) | Rationale: CDK-provided helper functions (e.g. S3 bucket notifications) may lag the newest runtime | Alternative: N/A for our own handlers, which are all on the latest runtime',
      },
      {
        id: 'AwsSolutions-CFR1',
        reason: 'ADR: No CloudFront geo-restriction | Rationale: Pilot frontend must be reachable for client testing | Alternative: Add geo allowlist (will evaluate for production)',
      },
      {
        id: 'AwsSolutions-CFR2',
        reason: 'ADR: No WAF on CloudFront | Rationale: POC/pilot cost optimization; static site fronting public APIs | Alternative: Attach CLOUDFRONT-scoped WAF (will add for production)',
      },
      {
        id: 'AwsSolutions-CFR3',
        reason: 'ADR: CloudFront access logging deferred | Rationale: POC phase cost optimization | Alternative: Enable access logs (will add for production)',
      },
      {
        id: 'AwsSolutions-CFR4',
        reason: 'ADR: Default CloudFront viewer certificate (TLSv1.2_2021 minimum) | Rationale: Using the default *.cloudfront.net domain; custom domain/ACM cert deferred | Alternative: Custom ACM cert (will add for production)',
      },
    ]);
  }
}
