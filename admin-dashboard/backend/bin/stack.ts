#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { AdminDashboardStack } from '../lib/admin-dashboard-stack';

const app = new cdk.App();
new AdminDashboardStack(app, 'AdminDashboardStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: 'us-east-1',
  },
});
