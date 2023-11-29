const AWS = require('aws-sdk');
const core = require('@actions/core');
const config = require('./config');

// User data scripts are run as the root user
function buildUserDataScript(githubRegistrationToken, label) {
  if (config.input.runnerHomeDir) {
    // If runner home directory is specified, we expect the actions-runner software (and dependencies)
    // to be pre-installed in the AMI, so we simply cd into that directory and then start the runner
    return [
      '#!/bin/bash',
      `cd "${config.input.runnerHomeDir}"`,
      `echo "${config.input.preRunnerScript}" > pre-runner-script.sh`,
      'source pre-runner-script.sh',
      'export RUNNER_ALLOW_RUNASROOT=1',
      `./config.sh --unattended --url https://github.com/${config.githubContext.owner}/${config.githubContext.repo} --token ${githubRegistrationToken} --labels ${label}`,
      './run.sh',
    ];
  } else {
    return [
      '#!/bin/bash',
      'mkdir actions-runner && cd actions-runner',
      `echo "${config.input.preRunnerScript}" > pre-runner-script.sh`,
      'source pre-runner-script.sh',
      'case $(uname -m) in aarch64) ARCH="arm64" ;; amd64|x86_64) ARCH="x64" ;; esac && export RUNNER_ARCH=${ARCH}',
      'curl -O -L https://github.com/actions/runner/releases/download/v2.311.0/actions-runner-linux-${RUNNER_ARCH}-2.311.0.tar.gz',
      'tar xzf ./actions-runner-linux-${RUNNER_ARCH}-2.311.0.tar.gz',
      'export RUNNER_ALLOW_RUNASROOT=1',
      `./config.sh --unattended --url https://github.com/${config.githubContext.owner}/${config.githubContext.repo} --token ${githubRegistrationToken} --labels ${label}`,
      './run.sh',
    ];
  }
}

async function getImageNameFromSSM(parameter_name) {
  const ssm = new AWS.SSM();
  const params = {
    Name: parameter_name,
    WithDecryption: true,
  };
  const result = await ssm.getParameter(params).promise();
  return result.Parameter.Value;
}

async function startEc2Instance(label, githubRegistrationToken) {
  const ec2 = new AWS.EC2();

  const userData = buildUserDataScript(githubRegistrationToken, label);
  const ImageId = await getImageNameFromSSM(config.input.ec2ImageId);
  if (config.input.useSpotInstance) {
    const params = {
      InstanceCount: 1,
      LaunchSpecification: {
        ImageId,
        InstanceType: config.input.ec2InstanceType,
        KeyName: config.input.keyName,
        UserData: Buffer.from(userData.join('\n')).toString('base64'),
        BlockDeviceMappings: [
          {
            DeviceName: '/dev/xvda',
            Ebs: {
              DeleteOnTermination: true,
              VolumeSize: config.input.volumeSize,
              Encrypted: true,
              VolumeType: 'gp2',
            },
          },
        ],
        NetworkInterfaces: [
          {
            DeviceIndex: 0,
            AssociatePublicIpAddress: config.input.usePublicIP,
            SubnetId: config.input.subnetId,
            Groups: [config.input.securityGroupId],
          },
        ],
        IamInstanceProfile: { Name: config.input.iamRoleName },
      },
    };

    try {
      let result = await ec2.requestSpotInstances(params).promise();
      core.info(`Spot request created, status: ${result.SpotInstanceRequests[0].State}`);
      core.info(`Waiting for spot instance provisioning.....`);

      const spotInstaceRequestParams = {
        SpotInstanceRequestIds: [result.SpotInstanceRequests[0].SpotInstanceRequestId],
      };

      const timeoutMinutes = 5;
      const retryIntervalSeconds = 10;
      let waitSeconds = 0;

      return new Promise((resolve, reject) => {
        const interval = setInterval(async () => {
          result = await ec2.describeSpotInstanceRequests(spotInstaceRequestParams).promise();

          if (waitSeconds > timeoutMinutes * 60) {
            core.error('Spot instance creation error');
            clearInterval(interval);
            reject(`A timeout of ${timeoutMinutes} minutes is exceeded. Your AWS EC2 spot instance was not created.`);
          }

          if (result.SpotInstanceRequests[0].State === 'active') {
            const ec2InstanceId = result.SpotInstanceRequests[0].InstanceId;
            if (config.tagSpecifications && config.tagSpecifications.length > 0) {
              const tagParams = {
                Resources: [ec2InstanceId],
                Tags: config.tagSpecifications,
              };
              await ec2.createTags(tagParams).promise();
            }
            core.info(`AWS EC2 instance ${ec2InstanceId} is started`);
            clearInterval(interval);
            resolve(ec2InstanceId);
          } else {
            waitSeconds += retryIntervalSeconds;
            core.info('Checking...');
          }
        }, retryIntervalSeconds * 1000);
      });
    } catch (error) {
      core.error('AWS EC2 spot instance starting error');
      throw error;
    }
  } else {
    const params = {
      ImageId,
      InstanceType: config.input.ec2InstanceType,
      KeyName: config.input.keyName,
      MinCount: 1,
      MaxCount: 1,
      UserData: Buffer.from(userData.join('\n')).toString('base64'),
      BlockDeviceMappings: [
        {
          DeviceName: '/dev/xvda',
          Ebs: {
            DeleteOnTermination: true,
            VolumeSize: config.input.volumeSize,
            Encrypted: true,
            VolumeType: 'gp2',
          },
        },
      ],
      NetworkInterfaces: [
        {
          AssociatePublicIpAddress: config.input.usePublicIP,
          SubnetId: config.input.subnetId,
          Groups: [config.input.securityGroupId],
        },
      ],
      IamInstanceProfile: { Name: config.input.iamRoleName },
      TagSpecifications: config.tagSpecifications,
    };

    try {
      const result = await ec2.runInstances(params).promise();
      const ec2InstanceId = result.Instances[0].InstanceId;
      core.info(`AWS EC2 instance ${ec2InstanceId} is started`);
      return ec2InstanceId;
    } catch (error) {
      core.error('AWS EC2 instance starting error');
      throw error;
    }
  }
}

async function terminateEc2Instance() {
  const ec2 = new AWS.EC2();

  const params = {
    InstanceIds: [config.input.ec2InstanceId],
  };

  try {
    await ec2.terminateInstances(params).promise();
    core.info(`AWS EC2 instance ${config.input.ec2InstanceId} is terminated`);
    return;
  } catch (error) {
    core.error(`AWS EC2 instance ${config.input.ec2InstanceId} termination error`);
    throw error;
  }
}

async function waitForInstanceRunning(ec2InstanceId) {
  const ec2 = new AWS.EC2();

  const params = {
    InstanceIds: [ec2InstanceId],
  };

  try {
    await ec2.waitFor('instanceRunning', params).promise();
    core.info(`AWS EC2 instance ${ec2InstanceId} is up and running`);
    return;
  } catch (error) {
    core.error(`AWS EC2 instance ${ec2InstanceId} initialization error`);
    throw error;
  }
}

module.exports = {
  startEc2Instance,
  terminateEc2Instance,
  waitForInstanceRunning,
};
