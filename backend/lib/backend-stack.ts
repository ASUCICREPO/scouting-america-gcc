import * as cdk from 'aws-cdk-lib';
import { Aspects } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { AwsSolutionsChecks, NagSuppressions } from 'cdk-nag';
import { SharedResources } from './constructs/shared-resources';

export class BackendStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ADR: cdk-nag scoped to stack, not app entry point
    // Rationale: Self-contained security checks travel with the stack when used as a template
    // Alternative: Aspects.of(app) in bin/backend.ts (rejected - doesn't travel with stack)
    Aspects.of(this).add(new AwsSolutionsChecks({ verbose: true }));

    // ---------------------------------------------------------------
    // Shared Resources (S3, DynamoDB, Cognito, SNS, Secrets Manager)
    // ---------------------------------------------------------------
    const sharedResources = new SharedResources(this, 'SharedResources');

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
        id: 'AwsSolutions-SNS2',
        reason: 'ADR: SNS encryption deferred | Rationale: Non-sensitive alert metadata only | Alternative: KMS encryption (will add if PII flows through topic)',
      },
      {
        id: 'AwsSolutions-SNS3',
        reason: 'ADR: SNS SSL enforcement deferred | Rationale: POC phase, subscribers are AWS services | Alternative: Require SSL (will add for production)',
      },
      {
        id: 'AwsSolutions-SMG4',
        reason: 'ADR: Secret rotation deferred | Rationale: Guardrails are app config, not credentials | Alternative: Enable rotation (not applicable for config data)',
      },
    ]);
  }
}
