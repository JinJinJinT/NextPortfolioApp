import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as codebuild from "aws-cdk-lib/aws-codebuild";
import * as codeDeploy from "aws-cdk-lib/aws-codedeploy";
import * as codepipeline from "aws-cdk-lib/aws-codepipeline";
import * as codepipeline_actions from "aws-cdk-lib/aws-codepipeline-actions";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as iam from "aws-cdk-lib/aws-iam";
import { log } from "console";

export class NextPortfolioAppStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ECR Repository for storing built Docker images
    const repository = new ecr.Repository(this, "NextJsPortfolioRepository", {
      repositoryName: "nextjs-portfolio-images",
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // VPC setup
    const vpc = new ec2.Vpc(this, "VPC");

    // Application Load Balancer
    const alb = new elbv2.ApplicationLoadBalancer(this, "ALB", {
      vpc,
      internetFacing: true,
    });

    // Load balancer listener to forward requests to the target group
    const listener = alb.addListener("Listener", {
      port: 80,
      //defaultAction: elbv2.ListenerAction.forward([blueTargetGroup]),
      protocol: elbv2.ApplicationProtocol.HTTP,
    });

    // Create ECS Cluster
    const cluster = new ecs.Cluster(this, "Cluster", { vpc });

    // Register a task definition
    const taskDefinition = new ecs.FargateTaskDefinition(this, "TaskDef", {
      memoryLimitMiB: 512,
      cpu: 256,
      executionRole: new iam.Role(this, "TaskExecutionRole", {
        assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
      }),
    });

    taskDefinition.addContainer("NextJsContainer", {
      containerName: "NextJsContainer",
      image: ecs.ContainerImage.fromEcrRepository(repository),
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: "NextJsApp" }),
      environment: { NODE_ENV: "production" },
      // Correct port mapping setup
      portMappings: [
        {
          containerPort: 3000,
        },
      ],
    });

    // ECS Service with Blue/Green Deployment
    const ecsService = new ecs.FargateService(this, "EcsService", {
      cluster: cluster,
      taskDefinition: taskDefinition,
      // circuitBreaker: {
      //   enable: true,
      //   rollback: true,
      // },
      desiredCount: 2,
      deploymentController: {
        type: ecs.DeploymentControllerType.CODE_DEPLOY,
      },
      assignPublicIp: true,
      // securityGroups: [
      //   new ec2.SecurityGroup(this, "ServiceSecurityGroup", { vpc }),
      // ],
    });

    // attach blue target group to the ECS service
    const blueTargetGroup = listener.addTargets("AddBlueTarget", {
      targetGroupName: "BlueTargetGroup",
      targets: [ecsService],
      protocol: elbv2.ApplicationProtocol.HTTP,
      port: 3000,
    });

    // CodeBuild and CodePipeline setup
    const githubToken = cdk.SecretValue.secretsManager("GithubToken");

    const pipeline = new codepipeline.Pipeline(this, "NextJsAppPipeline");
    const sourceOutput = new codepipeline.Artifact();
    const sourceAction = new codepipeline_actions.GitHubSourceAction({
      actionName: "Source",
      owner: "JinJinJinT",
      repo: "EpicPortfolio",
      branch: "main",
      oauthToken: githubToken,
      output: sourceOutput,
    });

    pipeline.addStage({
      stageName: "Source",
      actions: [sourceAction],
    });

    const buildProjectRole: iam.IRole = new iam.Role(this, "CodeBuildRole", {
      assumedBy: new iam.ServicePrincipal("codebuild.amazonaws.com"),
    });
    buildProjectRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ["ecr:GetAuthorizationToken"],
        resources: ["*"],
      })
    );
    buildProjectRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: [
          "ecr:CompleteLayerUpload",
          "ecr:UploadLayerPart",
          "ecr:InitiateLayerUpload",
          "ecr:BatchCheckLayerAvailability",
          "ecr:PutImage",
        ],
        resources: [repository.repositoryArn],
      })
    );

    const buildProject = new codebuild.PipelineProject(this, "BuildProject", {
      role: buildProjectRole,
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_5_0,
        privileged: true,
      },
      environmentVariables: {
        REPOSITORY_URI: { value: repository.repositoryUri },
        TASK_DEFINITION_ARN: { value: taskDefinition.taskDefinitionArn },
      },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: "0.2",
        phases: {
          pre_build: {
            commands: [
              "echo Logging in to Amazon ECR...",
              "aws ecr get-login-password --region $AWS_DEFAULT_REGION | docker login --username AWS --password-stdin $REPOSITORY_URI",
            ],
          },
          build: {
            commands: [
              "echo Build started on `date`",
              "echo Building the Docker image...",
              `docker build -t $REPOSITORY_URI:latest .`,
              `docker tag $REPOSITORY_URI:latest $REPOSITORY_URI:$CODEBUILD_RESOLVED_SOURCE_VERSION`,
            ],
          },
          post_build: {
            commands: [
              "echo Pushing the Docker image...",
              `docker push $REPOSITORY_URI:latest`,
              `docker push $REPOSITORY_URI:$CODEBUILD_RESOLVED_SOURCE_VERSION`,
              "echo Writing task definition file...",
              `printf '{"family":"MyTaskDefinition","containerDefinitions":[{"name":"NextJsContainer","image":"%s","cpu":256,"memory":512,"essential":true,"portMappings":[{"containerPort":3000,"hostPort":3000}]}]}' $REPOSITORY_URI:$CODEBUILD_RESOLVED_SOURCE_VERSION > taskdef.json`,
              "cat taskdef.json",
              "echo Writing appspec ile...",
              "printf \"version: 0.0\nResources:\n  - TargetService:\n      Type: AWS::ECS::Service\n      Properties:\n        TaskDefinition: %s\n        LoadBalancerInfo:\n          ContainerName: 'NextJsContainer'\n          ContainerPort: 3000\" $TASK_DEFINITION_ARN > appspec.yaml",
              "cat appspec.yaml",
              // check if the task definition is valid
              "echo Checking task definition file...",
              "cat taskdef.json | jq",
            ],
          },
        },
        artifacts: {
          files: ["taskdef.json", "appspec.yaml"],
        },
      }),
    });

    const buildOutput = new codepipeline.Artifact("BuildOutput");

    const buildAction = new codepipeline_actions.CodeBuildAction({
      actionName: "Build",
      project: buildProject,
      input: sourceOutput,
      outputs: [buildOutput],
    });

    pipeline.addStage({
      stageName: "Build",
      actions: [buildAction],
    });

    // add manual approval stage
    pipeline.addStage({
      stageName: "ApproveDeploy",
      actions: [
        new codepipeline_actions.ManualApprovalAction({
          actionName: "Approve",
        }),
      ],
    });

    // create deploy application
    const codeDeployApp = new codeDeploy.EcsApplication(this, "CodeDeployApp");

    // Add Green Target Group to the listener (cannot use addTargets because we need 0% weight for the green target group)
    // const greenTargetGroup = new elbv2.ApplicationTargetGroup(
    //   this,
    //   "GreenTargetGroup",
    //   {
    //     vpc: vpc,
    //     port: 3000,
    //     protocol: elbv2.ApplicationProtocol.HTTP,
    //     targetType: elbv2.TargetType.IP,
    //   }
    // );
    // const deploymentConfig = new codeDeploy.EcsDeploymentConfig(
    //   this,
    //   "DeploymentConfig",
    //   {
    //     trafficRouting: codeDeploy.TrafficRouting.timeBasedCanary({
    //       interval: cdk.Duration.minutes(1),
    //       percentage: 10,
    //     }),
    //   }
    // );
    const greenTargetGroup = listener.addTargets("AddGreenTarget", {
      targetGroupName: "GreenTargetGroup",
      targets: [ecsService],
      protocol: elbv2.ApplicationProtocol.HTTP,
      port: 3000,
    });

    listener.addTargetGroups("AddTargetGroups", {
      targetGroups: [blueTargetGroup, greenTargetGroup],
    });

    // const blueGreenDeploymentConfigurationProperty: codeDeploy.CfnDeploymentGroup.BlueGreenDeploymentConfigurationProperty =
    //   {
    //     deploymentReadyOption: {
    //       actionOnTimeout: "CONTINUE_DEPLOYMENT",
    //       waitTimeInMinutes: 2,
    //     },
    //     greenFleetProvisioningOption: {
    //       action: "DISCOVER_EXISTING",
    //     },
    //     terminateBlueInstancesOnDeploymentSuccess: {
    //       action: "TERMINATE",
    //       terminationWaitTimeInMinutes: 10,
    //     },
    //   };

    const CfnDeploymentConfig = new codeDeploy.CfnDeploymentConfig(
      this,
      "DeploymentConfig",
      {
        computePlatform: "ECS",
        deploymentConfigName: "TimeBasedCanary10Percent",
        minimumHealthyHosts: {
          type: "FLEET_PERCENT",
          value: 0,
        },
        trafficRoutingConfig: {
          type: "TimeBasedLinear",
          timeBasedLinear: {
            linearInterval: 1,
            linearPercentage: 10,
          },
        },
      }
    );

    const deployConfig = new codeDeploy.EcsDeploymentConfig(
      this,
      "DeployConfig",
      {
        trafficRouting: codeDeploy.TrafficRouting.timeBasedCanary({
          interval: cdk.Duration.minutes(1),
          percentage: 10,
        }),
        deploymentConfigName: "TimeBasedCanary10Percent",
      }
    );

    const deploymentGroup = new codeDeploy.EcsDeploymentGroup(
      this,
      "DeploymentGroup",
      {
        application: codeDeployApp,
        service: ecsService,
        autoRollback: {
          failedDeployment: true,
          stoppedDeployment: true,
        },
        deploymentConfig: {
          deploymentConfigName: deployConfig.deploymentConfigName,
          deploymentConfigArn: deployConfig.deploymentConfigArn,
        },
        blueGreenDeploymentConfig: {
          blueTargetGroup: blueTargetGroup,
          greenTargetGroup: greenTargetGroup,
          listener: listener,
        },
        role: new iam.Role(this, "CodeDeployRole", {
          assumedBy: new iam.ServicePrincipal("codedeploy.amazonaws.com"),
        }),
      }
    );

    const deployAction = new codepipeline_actions.CodeDeployEcsDeployAction({
      actionName: "Deploy",
      deploymentGroup: deploymentGroup,
      appSpecTemplateInput: buildOutput,
      taskDefinitionTemplateInput: buildOutput,
    });

    pipeline.addStage({
      stageName: "Deploy",
      actions: [deployAction],
    });

    // Note: Additional configurations for security groups, IAM roles, and Cloudflare DNS management need to be implemented outside of CDK.
  }
}
