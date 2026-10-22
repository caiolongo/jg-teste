#!/bin/bash
# Runs once LocalStack is ready. Creates the wagering queues and wires the DLQ redrive.
set -euo pipefail

REGION="${AWS_DEFAULT_REGION:-us-east-1}"
MAX_RECEIVE_COUNT="${WAGER_MAX_RECEIVE_COUNT:-8}"

DLQ_URL=$(awslocal sqs create-queue \
  --region "$REGION" \
  --queue-name wager-transactions-dlq.fifo \
  --attributes FifoQueue=true,ContentBasedDeduplication=false \
  --query QueueUrl --output text)

DLQ_ARN=$(awslocal sqs get-queue-attributes \
  --region "$REGION" \
  --queue-url "$DLQ_URL" \
  --attribute-names QueueArn \
  --query Attributes.QueueArn --output text)

awslocal sqs create-queue \
  --region "$REGION" \
  --queue-name wager-transactions.fifo \
  --attributes "{
    \"FifoQueue\": \"true\",
    \"ContentBasedDeduplication\": \"false\",
    \"VisibilityTimeout\": \"30\",
    \"RedrivePolicy\": \"{\\\"deadLetterTargetArn\\\":\\\"$DLQ_ARN\\\",\\\"maxReceiveCount\\\":\\\"$MAX_RECEIVE_COUNT\\\"}\"
  }" >/dev/null

# Created last: the compose healthcheck waits for this queue, so all queues exist once it passes.
awslocal sqs create-queue --region "$REGION" --queue-name wagering-events >/dev/null

echo "wagering queues ready"
