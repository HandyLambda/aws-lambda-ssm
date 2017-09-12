# Lambda SSM Invoker

A Node package that contains a lambda function for invoking ssm documents on given instances

## Terraform Usage

In this example, a cloudwatch alert is configured to trigger the run of an ssm command via
the following flow:

cloudwatch metric -> cloudwatch alarm -> sns topic -> lambda -> ssm

The alert is that the disk is running out of space, and the ssm command performs a cleanup activity.
 
This assumes a project setup:

|-- project
   |-- scripts
   |   `-- aws-lambda-ssm (this project)       
   `-- terraform
       `-- ssm_config.tf

### Prereq variables

Configure the following variables:

```hcl-terraform
variable "instance_to_monitor" {
  default = "i-123123123"
}
variable "aws_region" {}
variable "aws_account_no" {}
```

### Configure the cloudwatch trigger

Configure an sns topic and configure a cloudwatch metric alarm that notifies that topic when disk used goes above the desired threshold
(the variable could be replaced by a reference to a created `aws_instance` resource, for example `${aws_instance.my_instance_to_clean.id}`):

```hcl-terraform
resource "aws_sns_topic" "clean_instance" {
  name = "clean_instance"
}

resource "aws_cloudwatch_metric_alarm" "disk_used_my_instance" {
  alarm_name = "disk-root-used-${var.instance_to_monitor}"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods = "2"
  metric_name = "df.percent_bytes.used"
  namespace = "collectd"
  period = "120"
  statistic = "Maximum"
  threshold = "80"
  alarm_description = "This metric monitors ec2 root disk partition utilization"
  alarm_actions = ["${aws_sns_topic.clean_instance.arn}"]
  dimensions {
    PluginInstance = "root"
    Host = "${var.instance_to_monitor}"
  }
}
```

### Configure the ssm document

Configure the ssm document, which defined the instance cleanup task:

```hcl-terraform
resource "aws_ssm_document" "clean_instance" {
  name = "clean-instance"
  document_type = "Command"
  content = <<DOC
    {
        "schemaVersion":"1.2",
        "description":"Runs the 'some-cleanup-script.sh'",
        "parameters":{},
        "runtimeConfig":{
            "aws:runShellScript":{
                "properties":[
                    {
                        "id":"0.aws:runShellScript",
                        "runCommand":["rm -rf /var/log/some-useless-stuff"],
                        "timeoutSeconds":"60"
                    }
                ]
            }
        }
    }
DOC
}
```

### Configure the lambda function

Package the lambda function:

```hcl-terraform
data "archive_file" "lambda_ssm_zip" {
  type = "zip"
  // Only the index.js is packaged, as it is not easy/clean to get AWS Lambdas to install node dependencies.
  // All depencies in package.json are dev dependenices required for testing only.
  source_file = "${path.module}/scripts/aws-lambda-ssm/index.js"
  output_path = "${path.module}/scripts/aws-lambda-ssm/dist/aws-lambda-ssm.zip"
}
```

Create the lambda function, and add a basic role with permission to write logs to cloudwatch (useful for lambda debugging):

```hcl-terraform
resource "aws_iam_role" "lambda_ssm_clean_instance" {
  name = "sns_lambda_ssm_clean_instance"
  assume_role_policy = "${data.aws_iam_policy_document.lambda.json}"
}

data "aws_iam_policy_document" "lambda" {
  statement {
    actions = ["sts:AssumeRole"],
    principals {
      identifiers = ["lambda.amazonaws.com"]
      type = "Service"
    }
    effect = "Allow"
    sid = "LambdaBase"
  }
}

resource "aws_iam_role_policy_attachment" "lambda_ssm_clean_instance-CloudWatchLogsFullAccess" {
  role = "${aws_iam_role.lambda_ssm_clean_instance.name}"
  policy_arn = "arn:aws:iam::aws:policy/CloudWatchLogsFullAccess"
}

resource "aws_lambda_function" "ssm_clean_node" {
  filename = "${data.archive_file.lambda_ssm_zip.output_path}"
  function_name = "ssm_clean_instance"
  role = "${aws_iam_role.lambda_ssm_clean_instance.arn}"
  handler = "index.handler"
  source_code_hash = "${data.archive_file.lambda_ssm_zip.output_base64sha256}"
  runtime = "nodejs6.10"
  description = "runs clean tasks on my instance"
  environment {
    variables {
      SSM_DOCUMENT = "${aws_ssm_document.clean_instance.name}"
      INSTANCE_IDS = "${var.instance_to_monitor}"
    }
  }
}
```

### Configure lambda ssm permissions

In order to perform the required read and execute ssm operations, lambda requires the following
permission configuration:

```hcl-terraform
data "aws_iam_policy_document" "ssm_clean_instance" {
  statement {
    effect = "Allow"
    actions = ["ssm:SendCommand"]
    resources = [
      "arn:aws:ec2:${var.aws_region}:${var.aws_account_no}:instance/${var.instance_to_monitor}",
      "arn:aws:ssm:${var.aws_region}:${var.aws_account_no}:document/${aws_ssm_document.clean_instance.name}"
    ]
  }
}

resource "aws_iam_policy" "ssm_clean_instance" {
  name = "ssm_clean_instance"
  policy = "${data.aws_iam_policy_document.ssm_clean_instance.json}"
}

resource "aws_iam_role_policy_attachment" "iam_lambda_ssm_clean_instance" {
  role = "${aws_iam_role.lambda_ssm_clean_instance.name}"
  policy_arn = "${aws_iam_policy.ssm_clean_instance.arn}"
}

data "aws_iam_policy_document" "get_ssm_invocations" {
  statement {
    effect = "Allow"
    actions = [
      "ssm:GetCommandInvocation"
    ]
    resources = [
      "arn:aws:ssm:${var.aws_region}:${var.aws_account_no}:*"]
  }
}

resource "aws_iam_policy" "get_ssm_invocations" {
  name = "get_ssm_invocations"
  policy = "${data.aws_iam_policy_document.get_ssm_invocations.json}"
}

resource "aws_iam_role_policy_attachment" "iam_lambda_get_ssm_invocations" {
  role = "${aws_iam_role.lambda_ssm_clean_instance.name}"
  policy_arn = "${aws_iam_policy.get_ssm_invocations.arn}"
}
```

### Subscribe lambda to cloudwatch trigger  

Subscribe the lambda function to the sns topic so that it triggers when the topic is notified.
You will also need to configure a lambda permission for this:

```hcl-terraform
resource "aws_sns_topic_subscription" "sns_docker_clean" {
  topic_arn = "${aws_sns_topic.clean_instance.arn}"
  protocol = "lambda"
  endpoint = "${aws_lambda_function.ssm_clean_instance.arn}"
}

resource "aws_lambda_permission" "sns_clean_instance" {
  statement_id = "AllowExecutionFromSNS"
  action = "lambda:InvokeFunction"
  function_name = "${aws_lambda_function.ssm_clean_instance.function_name}"
  principal = "sns.amazonaws.com"
  source_arn = "${aws_sns_topic.clean_instance.arn}"
}
```

## Manual Usage

### 1. Create ssm document

Create SSM document in aws ec2. 

### 2. Configure Lambda function

Package the lambda function:

    npm run package
    
Create a Lambda function in AWS. Upload the `dist/aws-lambda-ssm.zip` file generated from the previous step. 

Use the following params:

handler: index.handler
runtime: nodejs6.10

Insert the following environment variables:

SSM_DOCUMENT: your-ssm-document
INSTANCE_IDS: i-11111111111,i-22222222222

### 3. Configure a trigger

#### Cloudwatch alarm

Create sns topic. 

In the topic, create a subscription to the lambda function

Create a new alarm in cloudwatch

Configure the alarm actions to send message to the sns topic created above.

## Development

We currently use Terraform to package just the index.js. **Important:** Only the index.js is packaged, as it is not 
easy/clean to get AWS Lambdas to install node dependencies. All dependencies in package.json are dev dependencies 
required for testing only.

Lambda functions by default have access to the AWS sdk for the given language
