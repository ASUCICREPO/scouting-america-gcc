import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';
import { CONFIG } from '../config/environment';

export interface SharedResourcesProps {
  /**
   * Optional Lambda function to trigger on S3 ObjectCreated events
   * in the document store bucket. Pass the Doc Processor Lambda here.
   */
  docProcessorFunction?: lambda.IFunction;
}

export class SharedResources extends Construct {
  // S3 Buckets
  public readonly documentStoreBucket: s3.Bucket;
  public readonly knowledgeBaseBucket: s3.Bucket;

  // DynamoDB Tables
  public readonly chatLogsTable: dynamodb.Table;
  public readonly analyticsLogsTable: dynamodb.Table;

  // Cognito
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;

  // Secrets Manager
  public readonly guardrailsSecret: secretsmanager.Secret;

  // SNS
  public readonly staffAlertTopic: sns.Topic;

  constructor(scope: Construct, id: string, props?: SharedResourcesProps) {
    super(scope, id);

    // ---------------------------------------------------------------
    // S3 Buckets
    // ---------------------------------------------------------------

    // Document store: raw uploaded docs
    this.documentStoreBucket = new s3.Bucket(this, 'DocumentStoreBucket', {
      bucketName: CONFIG.DOCUMENT_STORE_BUCKET,
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      enforceSSL: true,
    });

    // Knowledge base data: processed chunks for Bedrock KB
    this.knowledgeBaseBucket = new s3.Bucket(this, 'KnowledgeBaseBucket', {
      bucketName: CONFIG.KNOWLEDGE_BASE_BUCKET,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      enforceSSL: true,
    });

    // S3 event notification — triggers Doc Processor on new uploads
    if (props?.docProcessorFunction) {
      this.documentStoreBucket.addEventNotification(
        s3.EventType.OBJECT_CREATED,
        new s3n.LambdaDestination(props.docProcessorFunction),
        { prefix: 'uploads/' },
      );
    }

    // ---------------------------------------------------------------
    // DynamoDB Tables
    // ---------------------------------------------------------------

    // ChatLogs table
    this.chatLogsTable = new dynamodb.Table(this, 'ChatLogsTable', {
      tableName: CONFIG.CHAT_LOGS_TABLE,
      partitionKey: { name: 'sessionId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'timestamp', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    });

    // GSI: userId-index for querying by user
    this.chatLogsTable.addGlobalSecondaryIndex({
      indexName: 'userId-index',
      partitionKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'timestamp', type: dynamodb.AttributeType.STRING },
    });

    // AnalyticsLogs table
    this.analyticsLogsTable = new dynamodb.Table(this, 'AnalyticsLogsTable', {
      tableName: CONFIG.ANALYTICS_LOGS_TABLE,
      partitionKey: { name: 'eventType', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'timestamp', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    });

    // ---------------------------------------------------------------
    // Cognito User Pool
    // ---------------------------------------------------------------

    this.userPool = new cognito.UserPool(this, 'GCCUserPool', {
      userPoolName: 'GCC-VolunteerPool',
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      autoVerify: { email: true },
      standardAttributes: {
        email: { required: true, mutable: true },
        givenName: { required: true, mutable: true },
        familyName: { required: true, mutable: true },
      },
      passwordPolicy: {
        minLength: 8,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // Cognito groups
    new cognito.CfnUserPoolGroup(this, 'VolunteersGroup', {
      userPoolId: this.userPool.userPoolId,
      groupName: 'volunteers',
      description: 'Registered volunteer leaders',
    });

    new cognito.CfnUserPoolGroup(this, 'AdminGroup', {
      userPoolId: this.userPool.userPoolId,
      groupName: 'admin',
      description: 'GCC administrators with full access',
    });

    // User Pool Client for frontend
    this.userPoolClient = this.userPool.addClient('GCCWebClient', {
      userPoolClientName: 'GCC-WebApp',
      authFlows: {
        userPassword: true,
        userSrp: true,
      },
      preventUserExistenceErrors: true,
    });

    // ---------------------------------------------------------------
    // Secrets Manager
    // ---------------------------------------------------------------

    this.guardrailsSecret = new secretsmanager.Secret(this, 'GuardrailsSecret', {
      secretName: 'gcc-system-guardrails',
      description: 'System instructions and guardrails for the AI assistant',
      secretStringValue: cdk.SecretValue.unsafePlainText(JSON.stringify({
        systemPrompt: 'You are the GCC AI Volunteer Support Assistant. Answer questions using only approved GCC and Scouting America resources. If you are unsure or the question is about safety, youth protection, or emergencies, clearly state your limitations and direct the user to appropriate human contacts.',
        lastUpdated: new Date().toISOString(),
      })),
    });

    // ---------------------------------------------------------------
    // SNS Topic
    // ---------------------------------------------------------------

    this.staffAlertTopic = new sns.Topic(this, 'StaffAlertTopic', {
      topicName: CONFIG.STAFF_ALERT_TOPIC,
      displayName: 'GCC Staff Alerts - Escalation Notifications',
    });
  }
}
