import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import { Construct } from 'constructs';

export interface FrontendHostingProps {
  /**
   * ISO 3166-1 alpha-2 country codes allowed to access the site.
   * Defaults to US-only.
   */
  allowedCountries?: string[];
}

/**
 * Static hosting for the Next.js frontend (built with `output: 'export'`)
 * behind CloudFront, with built-in US-only geo-restriction.
 *
 * - Private S3 bucket (no public access) holding the exported static site.
 * - CloudFront distribution with Origin Access Control (OAC) reading from S3.
 * - CloudFront geo-restriction set to an allowlist (US by default) so the
 *   site is only served to viewers in the United States. This is native to
 *   CloudFront — no WAF cost — and is evaluated at the edge.
 *
 * Deploy the built site with:
 *   aws s3 sync frontend/out s3://<SiteBucket> --delete
 *   aws cloudfront create-invalidation --distribution-id <Id> --paths "/*"
 */
export class FrontendHosting extends Construct {
  public readonly siteBucket: s3.Bucket;
  public readonly distribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props?: FrontendHostingProps) {
    super(scope, id);

    const allowedCountries = props?.allowedCountries ?? ['US'];

    // Private bucket for the exported static site.
    this.siteBucket = new s3.Bucket(this, 'SiteBucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // CloudFront distribution with US-only geo-restriction.
    this.distribution = new cloudfront.Distribution(this, 'SiteDistribution', {
      comment: 'GCC Volunteer Assistant frontend (US-only)',
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(this.siteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      defaultRootObject: 'index.html',
      // Geo-restriction: only serve viewers in the allowed countries.
      geoRestriction: cloudfront.GeoRestriction.allowlist(...allowedCountries),
      // Static-export friendly error handling for client-side routing.
      errorResponses: [
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
        },
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
        },
      ],
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
    });

    new cdk.CfnOutput(this, 'FrontendBucketName', {
      value: this.siteBucket.bucketName,
      description: 'S3 bucket holding the exported frontend static site',
    });

    new cdk.CfnOutput(this, 'FrontendDistributionId', {
      value: this.distribution.distributionId,
      description: 'CloudFront distribution ID for the frontend',
    });

    new cdk.CfnOutput(this, 'FrontendUrl', {
      value: `https://${this.distribution.distributionDomainName}`,
      description: 'Public (US-only) URL of the frontend',
    });
  }
}
