import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';

/**
 * Shared Python dependencies packaged once as a Lambda layer.
 *
 * The local bundler builds Linux/x86_64 wheels even when CDK is synthesized on
 * macOS. Lambda's Python runtime supplies boto3; only application dependencies
 * are included here.
 */
export class PythonDependencies extends Construct {
  public readonly layer: lambda.LayerVersion;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    const dependencyDir = path.join(__dirname, '../../lambda/python-dependencies');
    const requirementsFile = path.join(dependencyDir, 'requirements.txt');
    const code = process.env.CDK_TEST_SKIP_PYTHON_BUNDLING === 'true'
      // Unit tests only inspect the synthesized layer reference. Avoid making
      // deterministic template tests depend on PyPI availability.
      ? lambda.Code.fromAsset(dependencyDir)
      : lambda.Code.fromAsset(dependencyDir, {
        assetHashType: cdk.AssetHashType.SOURCE,
        bundling: {
          image: lambda.Runtime.PYTHON_3_13.bundlingImage,
          command: ['bash', '-c', 'exit 1'],
          local: {
            tryBundle(outputDir: string): boolean {
              const destination = path.join(outputDir, 'python');
              fs.mkdirSync(destination, { recursive: true });
              childProcess.execFileSync('python3', [
                '-m',
                'pip',
                'install',
                '--disable-pip-version-check',
                '--platform',
                'manylinux2014_x86_64',
                '--implementation',
                'cp',
                '--python-version',
                '3.13',
                '--only-binary=:all:',
                '--requirement',
                requirementsFile,
                '--target',
                destination,
              ], { stdio: 'inherit' });
              return true;
            },
          },
        },
      });

    this.layer = new lambda.LayerVersion(this, 'Layer', {
      description: 'Shared Jinja2 and Pydantic dependencies for GCC Python Lambdas',
      compatibleRuntimes: [lambda.Runtime.PYTHON_3_13],
      code,
    });
  }
}
