import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';
import { PREFIX } from '../config/environment';

export interface ObservabilityProps {
  alertTopic: sns.ITopic;
  functions: lambda.IFunction[];
  deadLetterQueues: sqs.IQueue[];
  documentQueue: sqs.IQueue;
  escalationQueue: sqs.IQueue;
}

export class Observability extends Construct {
  public readonly dashboard: cloudwatch.Dashboard;

  constructor(scope: Construct, id: string, props: ObservabilityProps) {
    super(scope, id);

    const dlqMetrics = props.deadLetterQueues.map((queue) =>
      queue.metricApproximateNumberOfMessagesVisible({
        period: cdk.Duration.minutes(5),
        statistic: 'Maximum',
      }),
    );

    for (const queue of props.deadLetterQueues) {
      const alarm = new cloudwatch.Alarm(this, `${queue.node.id}MessagesAlarm`, {
        alarmName: `${PREFIX}${queue.node.id}-MessagesVisible`,
        alarmDescription: `Messages in ${queue.queueName} indicate an unprocessed failure or security event.`,
        metric: queue.metricApproximateNumberOfMessagesVisible({
          period: cdk.Duration.minutes(5),
          statistic: 'Maximum',
        }),
        threshold: 1,
        evaluationPeriods: 1,
        datapointsToAlarm: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
      alarm.addAlarmAction(new actions.SnsAction(props.alertTopic));
    }

    const escalationAgeAlarm = new cloudwatch.Alarm(this, 'EscalationQueueAgeAlarm', {
      alarmName: `${PREFIX}GCC-Escalation-OldestMessageAge`,
      alarmDescription: 'Escalation messages older than five minutes indicate delayed staff alerts.',
      metric: props.escalationQueue.metricApproximateAgeOfOldestMessage({
        period: cdk.Duration.minutes(1),
        statistic: 'Maximum',
      }),
      threshold: 300,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    escalationAgeAlarm.addAlarmAction(new actions.SnsAction(props.alertTopic));

    this.dashboard = new cloudwatch.Dashboard(this, 'OperationsDashboard', {
      dashboardName: `${PREFIX}GCC-Operations`,
    });
    this.dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Dead-letter queue messages',
        left: dlqMetrics,
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: 'Document ingestion queue depth and oldest message',
        left: [
          props.documentQueue.metricApproximateNumberOfMessagesVisible(),
          props.documentQueue.metricApproximateAgeOfOldestMessage(),
        ],
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: 'Escalation queue depth and oldest message',
        left: [
          props.escalationQueue.metricApproximateNumberOfMessagesVisible(),
          props.escalationQueue.metricApproximateAgeOfOldestMessage(),
        ],
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: 'Lambda errors and throttles',
        left: props.functions.flatMap((fn) => [fn.metricErrors(), fn.metricThrottles()]),
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: 'Lambda duration',
        left: props.functions.map((fn) => fn.metricDuration({ statistic: 'p95' })),
        width: 12,
      }),
    );
  }
}
