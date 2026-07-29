import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import { Construct } from 'constructs';
import { CONFIG } from '../config/environment';

export interface SharedResourcesProps {
  allowedOrigin: string;
}

export class SharedResources extends Construct {
  // S3 Buckets
  public readonly documentStoreBucket: s3.Bucket;
  public readonly knowledgeBaseBucket: s3.Bucket;
  public readonly chatArchiveBucket: s3.Bucket;

  // DynamoDB Tables
  public readonly chatLogsTable: dynamodb.Table;
  public readonly analyticsLogsTable: dynamodb.Table;

  // Cognito
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;

  // SNS
  public readonly staffAlertTopic: sns.Topic;

  constructor(scope: Construct, id: string, props: SharedResourcesProps) {
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
      // Only the deployed CloudFront frontend may use presigned uploads.
      cors: [
        {
          allowedMethods: [s3.HttpMethods.POST, s3.HttpMethods.GET, s3.HttpMethods.HEAD],
          allowedOrigins: [props.allowedOrigin],
          allowedHeaders: ['*'],
          exposedHeaders: ['ETag'],
          maxAge: 3000,
        },
      ],
    });

    // Knowledge base data: processed chunks for Bedrock KB
    this.knowledgeBaseBucket = new s3.Bucket(this, 'KnowledgeBaseBucket', {
      bucketName: CONFIG.KNOWLEDGE_BASE_BUCKET,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      enforceSSL: true,
    });

    // Immutable chat audit archive. DynamoDB remains the live query store for
    // history/admin screens; its stream is copied here for lower-cost retention
    // and future Athena/Glue analytics.
    this.chatArchiveBucket = new s3.Bucket(this, 'ChatArchiveBucket', {
      bucketName: CONFIG.CHAT_ARCHIVE_BUCKET,
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: true,
      objectLockEnabled: true,
      objectLockDefaultRetention: s3.ObjectLockRetention.governance(cdk.Duration.days(365)),
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      enforceSSL: true,
    });

    // Note: the S3 -> Doc Processor event notification is wired in backend-stack.ts
    // after both the bucket and the Doc Processor Lambda exist.

    // ---------------------------------------------------------------
    // DynamoDB Tables
    // ---------------------------------------------------------------

    // ChatLogs table
    this.chatLogsTable = new dynamodb.Table(this, 'ChatLogsTable', {
      tableName: CONFIG.CHAT_LOGS_TABLE,
      partitionKey: { name: 'sessionId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'timestamp', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      stream: dynamodb.StreamViewType.NEW_IMAGE,
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
      selfSignUpEnabled: false,
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
    // SNS Topic
    // ---------------------------------------------------------------

    this.staffAlertTopic = new sns.Topic(this, 'StaffAlertTopic', {
      topicName: CONFIG.STAFF_ALERT_TOPIC,
      displayName: 'GCC Staff Alerts - Escalation Notifications',
    });
    this.staffAlertTopic.addSubscription(
      new subscriptions.EmailSubscription(CONFIG.STAFF_EMAIL),
    );
  }
}
