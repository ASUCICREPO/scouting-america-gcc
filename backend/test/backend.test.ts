import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { ScoutingAmericaChatbot } from '../lib/backend-stack';

let template: Template;

beforeAll(() => {
  process.env.CDK_TEST_SKIP_PYTHON_BUNDLING = 'true';
  const app = new cdk.App();
  const stack = new ScoutingAmericaChatbot(app, 'TestStack', {
    env: { account: '123456789012', region: 'us-east-1' },
  });
  template = Template.fromStack(stack);
});

describe('S3 Vectors index metadata configuration', () => {
  // Regression test for the 2KB filterable-metadata limit that broke chat.
  // The chunk text (AMAZON_BEDROCK_TEXT) and source blob (AMAZON_BEDROCK_METADATA)
  // must be non-filterable so they don't count against the 2KB filterable budget.
  test('declares Bedrock text + metadata keys as non-filterable', () => {
    template.hasResourceProperties('AWS::S3Vectors::Index', {
      MetadataConfiguration: {
        NonFilterableMetadataKeys: Match.arrayWith([
          'AMAZON_BEDROCK_TEXT',
          'AMAZON_BEDROCK_METADATA',
        ]),
      },
    });
  });

  test('index dimension matches Titan Text Embeddings v2 (1024)', () => {
    template.hasResourceProperties('AWS::S3Vectors::Index', {
      Dimension: 1024,
      DistanceMetric: 'cosine',
    });
  });
});

describe('Lambda runtime', () => {
  // All handlers were migrated to Python 3.13 (team standard, Cincinnati
  // alignment). Guard against a regression back to a Node.js runtime.
  test('all Lambda functions run on python3.13', () => {
    const functions = template.findResources('AWS::Lambda::Function');
    const applicationFunctions = Object.entries(functions).filter(([logicalId]) =>
      /^(ChatHandler|DashboardApi|DocProcessor|EscalationRouter|ChatArchiver)/.test(logicalId),
    );
    const runtimes = applicationFunctions.map(([, fn]) => fn.Properties?.Runtime);
    expect(runtimes.length).toBeGreaterThan(0);
    for (const runtime of runtimes) {
      expect(runtime).toBe('python3.13');
    }
  });
});

describe('Bedrock data source chunking', () => {
  // Regression test: NONE chunking + whole-PDF copy made each document a single
  // oversized vector, overflowing even the 40KB total metadata budget. SEMANTIC
  // chunking splits by meaning boundaries and caps each chunk at 800 tokens,
  // keeping every vector within the S3 Vectors metadata limits.
  test('uses SEMANTIC chunking, not NONE', () => {
    template.hasResourceProperties('AWS::Bedrock::DataSource', {
      VectorIngestionConfiguration: {
        ChunkingConfiguration: {
          ChunkingStrategy: 'SEMANTIC',
          SemanticChunkingConfiguration: {
            MaxTokens: 800,
            BufferSize: 1,
            BreakpointPercentileThreshold: 95,
          },
        },
      },
    });
  });
});

describe('Grounded response generation controls', () => {
  test('provisions immutable Prompt Management and Guardrail versions', () => {
    template.resourceCountIs('AWS::Bedrock::Prompt', 1);
    template.resourceCountIs('AWS::Bedrock::PromptVersion', 1);
    template.resourceCountIs('AWS::Bedrock::Guardrail', 1);
    template.resourceCountIs('AWS::Bedrock::GuardrailVersion', 1);
  });

  test('applies the Guardrail and versioned prompt to the chat Lambda', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'GCC-ChatHandler',
      Environment: {
        Variables: Match.objectLike({
          GUARDRAIL_ID: Match.anyValue(),
          GUARDRAIL_VERSION: Match.anyValue(),
          PROMPT_ID: Match.anyValue(),
          PROMPT_VERSION: Match.anyValue(),
        }),
      },
    });
  });

  test('does not store system prompts in Secrets Manager', () => {
    template.resourceCountIs('AWS::SecretsManager::Secret', 0);
  });
});

describe('Bounded ingestion and immutable audit storage', () => {
  test('buffers document uploads in SQS with bounded worker concurrency', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Description: 'Copies uploaded documents to KB bucket and triggers Bedrock ingestion',
      ReservedConcurrentExecutions: 2,
    });
    template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      BatchSize: 1,
      ScalingConfig: { MaximumConcurrency: 2 },
    });
    template.hasResourceProperties('Custom::S3BucketNotifications', {
      NotificationConfiguration: {
        QueueConfigurations: Match.arrayWith([
          Match.objectLike({
            Events: ['s3:ObjectCreated:*'],
            Filter: {
              Key: {
                FilterRules: Match.arrayWith([
                  { Name: 'prefix', Value: 'uploads/' },
                ]),
              },
            },
          }),
        ]),
      },
    });
  });

  test('archives DynamoDB inserts in a one-year object-locked S3 bucket', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      StreamSpecification: { StreamViewType: 'NEW_IMAGE' },
    });
    template.hasResourceProperties('AWS::S3::Bucket', {
      ObjectLockEnabled: true,
      ObjectLockConfiguration: {
        ObjectLockEnabled: 'Enabled',
        Rule: {
          DefaultRetention: {
            Days: 365,
            Mode: 'GOVERNANCE',
          },
        },
      },
      VersioningConfiguration: { Status: 'Enabled' },
    });
  });
});

describe('Failure observability', () => {
  test('alarms on every application dead-letter queue', () => {
    template.resourceCountIs('AWS::CloudWatch::Alarm', 3);
    template.resourceCountIs('AWS::CloudWatch::Dashboard', 1);
  });

  test('subscribes the configured staff mailbox to alerts', () => {
    template.hasResourceProperties('AWS::SNS::Subscription', {
      Protocol: 'email',
      Endpoint: 'staff@grandcanyonbsa.org',
    });
  });
});

describe('CloudFront static route rewriting', () => {
  test('isolates public chat and admin dashboard in two distributions', () => {
    template.resourceCountIs('AWS::CloudFront::Distribution', 2);
    template.resourceCountIs('AWS::CloudFront::Function', 2);
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: {
        DefaultRootObject: 'login/index.html',
      },
    });
    template.hasResourceProperties('AWS::CloudFront::Function', {
      FunctionCode: Match.stringLikeRegexp("uri === '/dashboard'"),
    });
  });

  test('rewrites extensionless paths to their exported index.html files', () => {
    template.hasResourceProperties('AWS::CloudFront::Function', {
      AutoPublish: true,
      FunctionCode: Match.stringLikeRegexp("request\\.uri \\+= '/index\\.html'"),
      FunctionConfig: {
        Runtime: 'cloudfront-js-2.0',
      },
    });
  });

  test('associates the rewrite with viewer requests', () => {
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: {
        DefaultCacheBehavior: {
          FunctionAssociations: Match.arrayWith([
            Match.objectLike({ EventType: 'viewer-request' }),
          ]),
        },
      },
    });
  });
});

describe('Origin and session hardening', () => {
  test('scopes upload CORS to the admin distribution', () => {
    const buckets = Object.values(template.findResources('AWS::S3::Bucket'));
    const documentBucket = buckets.find(
      (resource) => resource.Properties?.BucketName === 'gcc-document-store',
    );
    const origins =
      documentBucket?.Properties?.CorsConfiguration?.CorsRules?.[0]?.AllowedOrigins;
    expect(origins).toHaveLength(1);
    expect(origins).not.toContain('*');
  });

  test('does not allow self-signup into the admin user pool', () => {
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      AdminCreateUserConfig: {
        AllowAdminCreateUserOnly: true,
      },
    });
  });

  test('passes distinct CloudFront origins to public and admin Lambdas', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'GCC-ChatHandler',
      Environment: {
        Variables: Match.objectLike({ ALLOWED_ORIGIN: Match.anyValue() }),
      },
    });
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'GCC-AdminDashboard',
      Environment: {
        Variables: Match.objectLike({ ALLOWED_ORIGIN: Match.anyValue() }),
      },
    });
  });
});
