#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { ScoutingAmericaChatbot } from '../lib/backend-stack';

const app = new cdk.App();
const stackName = process.env.STACK_NAME || 'ScoutingAmericaChatbot';

if (!/^[A-Za-z][A-Za-z0-9-]{0,127}$/.test(stackName)) {
  throw new Error(`Invalid CloudFormation stack name: ${stackName}`);
}

const stack = new ScoutingAmericaChatbot(app, stackName, {
  stackName,
  /* If you don't specify 'env', this stack will be environment-agnostic.
   * Account/Region-dependent features and context lookups will not work,
   * but a single synthesized template can be deployed anywhere. */

  /* Uncomment the next line to specialize this stack for the AWS Account
   * and Region that are implied by the current CLI configuration. */
  // env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },

  /* Uncomment the next line if you know exactly what Account and Region you
   * want to deploy the stack to. */
  // env: { account: '123456789012', region: 'us-west-2' },

  /* For more information, see https://docs.aws.amazon.com/cdk/latest/guide/environments.html */
});

cdk.Tags.of(stack).add('Project', 'ScoutingAmericaGCC');
cdk.Tags.of(stack).add('Deployment', process.env.RESOURCE_PREFIX || 'default');
cdk.Tags.of(stack).add('ManagedBy', 'deploy.sh');
