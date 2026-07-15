import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { ScoutingAmericaChatbot } from '../lib/backend-stack';

let template: Template;

beforeAll(() => {
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
      /^(ChatHandler|DashboardApi|DocProcessor|EscalationRouter)/.test(logicalId),
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

describe('CloudFront static route rewriting', () => {
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
