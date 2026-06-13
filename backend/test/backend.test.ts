import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { BackendStack } from '../lib/backend-stack';

let template: Template;

beforeAll(() => {
  const app = new cdk.App();
  const stack = new BackendStack(app, 'TestStack', {
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

describe('Bedrock data source chunking', () => {
  // Regression test: NONE chunking + whole-PDF copy made each document a single
  // oversized vector, overflowing even the 40KB total metadata budget. FIXED_SIZE
  // keeps each chunk small.
  test('uses FIXED_SIZE chunking, not NONE', () => {
    template.hasResourceProperties('AWS::Bedrock::DataSource', {
      VectorIngestionConfiguration: {
        ChunkingConfiguration: {
          ChunkingStrategy: 'FIXED_SIZE',
          FixedSizeChunkingConfiguration: {
            MaxTokens: 300,
            OverlapPercentage: 20,
          },
        },
      },
    });
  });
});
