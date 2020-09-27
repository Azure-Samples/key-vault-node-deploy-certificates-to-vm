/*
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for
 * license information.
 * 
 * This file uses an outdated library.  Please see the readme to find the latest version.
 */
'use strict';

const util = require('util');
const msRestAzure = require('ms-rest-azure');
const ComputeManagementClient = require('azure-arm-compute');
const NetworkManagementClient = require('azure-arm-network');
const ResourceManagementClient = require('azure-arm-resource').ResourceManagementClient;
const KeyVaultManagementClient = require('azure-arm-keyvault');
// #Deprecated Libraries
const KeyVault = require('azure-keyvault');
const GraphRBACClient = require('azure-graph');
const setTimeoutPromise = util.promisify(setTimeout);

_validateEnvironmentVariables();
let clientId = process.env['CLIENT_ID'];
let domain = process.env['DOMAIN'];
let secret = process.env['APPLICATION_SECRET'];
let objectId = process.env['AZURE_OBJECT_ID'];
let subscriptionId = process.env['AZURE_SUBSCRIPTION_ID'];
let resourceClient, computeClient, storageClient, networkClient, keyVaultManagementClient, keyVaultClient, graphClient;

//Sample Config
let randomIds = {};
let location = 'westus';
let resourceGroupName = _generateRandomId('testrg', randomIds);
let vmName = _generateRandomId('testvm', randomIds);
let vnetName = _generateRandomId('testvnet', randomIds);
let subnetName = _generateRandomId('testsubnet', randomIds);
let publicIPName = _generateRandomId('testpip', randomIds);
let networkInterfaceName = _generateRandomId('testnic', randomIds);
let ipConfigName = _generateRandomId('testcrpip', randomIds);
let domainNameLabel = _generateRandomId('testdomainname', randomIds);
let keyVaultName = _generateRandomId('testkv', randomIds);
let certificateName = _generateRandomId('testcert', randomIds);

//Refs
let vaultObj;
let certificateSecretObj;

// Ubuntu config
let publisher = 'Canonical';
let offer = 'UbuntuServer';
let sku = '16.04.0-LTS';

// Windows config
//let publisher = 'microsoftwindowsserver';
//let offer = 'windowsserver';
//let sku = '2012-r2-datacenter';

let adminUsername = 'notadmin';
let adminPassword = 'Pa$$w0rd92';

///////////////////////////////////////////
//     Entrypoint for sample script      //
///////////////////////////////////////////

msRestAzure.loginWithServicePrincipalSecret(clientId, secret, domain, function (err, credentials, subscriptions) {
  if (err) return console.log(err);
  resourceClient = new ResourceManagementClient(credentials, subscriptionId);
  computeClient = new ComputeManagementClient(credentials, subscriptionId);
  networkClient = new NetworkManagementClient(credentials, subscriptionId);
  keyVaultManagementClient = new KeyVaultManagementClient(credentials, subscriptionId);
  // #Deprecated Libraries
  keyVaultClient = new KeyVault.KeyVaultClient(credentials);
  graphClient = new GraphRBACClient(credentials, domain);

  // If objectId not provided, try to get it using graph
  if (!objectId) {
    credentials.tokenAudience = 'graph';
    graphClient.servicePrincipals.list({ filter: `appId eq '${clientId}'` }).then((result) => {
      objectId = result[0].objectId;
      credentials.tokenAudience = 'common';
      console.log("Got objectId from graph.");
      startSample();
    }).catch((err) => {
      console.log(err);
      console.log("Failed to get objectId from graph.");
    });
  } else {
    startSample();
  }
});

function startSample() {
  // Create a resource group
  let groupParameters = { location: location, tags: { sampletag: 'sampleValue' } };
  console.log('\n1.Creating resource group: ' + resourceGroupName);
  resourceClient.resourceGroups.createOrUpdate(resourceGroupName, groupParameters).then((group) => {
    print_item(group);

    // Create Keyvault
    console.log('\n2.Creating keyvault account');
    let keyVaultParameters = {
      location: location,
      properties: {
        sku: {
          name: 'standard',
        },
        accessPolicies: [
          {
            tenantId: domain,
            objectId: objectId,
            permissions: {
              certificates: ['all'],
              secrets: ['all']
            }
          }
        ],
        enabledForDeployment: true,
        tenantId: domain
      },
      tags: {}
    };
    return keyVaultManagementClient.vaults.createOrUpdate(resourceGroupName, keyVaultName, keyVaultParameters);
  }).then((vault) => {
    print_item(vault);

    // KeyVault recommentation is to wait 20 seconds after account creation for DNS update
    console.log("Waiting 20 seconds....");
    return setTimeoutPromise(20000, vault);
  }).then((vault) => {
    vaultObj = vault;
    console.log('Done waiting.');

    // Creating a certificate using your keyvault
    console.log('\n3.Creating keyvault certificate');
    let certificatePolicy = {
      keyProperties: {
        exportable: true,
        keyType: 'RSA',
        keySize: 2048,
        reuseKey: true
      },
      secretProperties: {
        contentType: 'application/x-pkcs12'
      },
      issuerParameters: {
        name: 'Self'
      },
      x509CertificateProperties: {
        subject: 'CN=CLIGetDefaultPolicy',
        validity_in_months: 12,
        key_usage: [
          "cRLSign",
          "dataEncipherment",
          "digitalSignature",
          "keyEncipherment",
          "keyAgreement",
          "keyCertSign"
        ]
      },
      lifetimeActions: [
        {
          action: { actionType: "AutoRenew" },
          trigger: { daysBeforeExpiry: 90 }
        }
      ]
    };
    // #Deprecated Libraries
    return keyVaultClient.createCertificate(vaultObj.properties.vaultUri, certificateName, { certificatePolicy: certificatePolicy });
  }).then((certificate) => {
    // Poll until certificate operation finishes
    function pollStatus() {
      console.log("Wait until certificate creation is finished");
      // #Deprecated Libraries
      return setTimeoutPromise(5000, keyVaultClient.getCertificateOperation(vaultObj.properties.vaultUri, certificateName)).then((result) => {
        if (result.status === "completed") {
          print_item(result);

          // Get certificate secret
          console.log('\n4.Get keyvault certificate as secret');
          // #Deprecated Libraries
          return keyVaultClient.getSecret(vaultObj.properties.vaultUri, certificateName, '')
        }
        else {
          return pollStatus();
        }
      });
    };
    return pollStatus();
  }).then((secret) => {
    certificateSecretObj = secret;
    print_item(secret);
    return createNetwork();
  }).then((nic)=>{
    print_item(nic);
    return createVirtualMachine(nic.id);
  }).then((vm) => {
    print_item(vm);
    return networkClient.publicIPAddresses.get(resourceGroupName, publicIPName);
  }).then((ipAddress) => {
    console.log(`You can connect to the VM using: ssh ${adminUsername}@${ipAddress.ipAddress}`);
    console.log(`And password: ${adminPassword}\n`);
    console.log("Your certificate is available in this folder: /var/lib/waagent");
    console.log("You must be root to see it (sudo su)\n");
    console.log(`/nDeleting the resource group: ${resourceGroupName}`);
    // Comment the line below to retain your sample resources
    return resourceClient.resourceGroups.deleteMethod(resourceGroupName);
  }).then((result) => {
    console.log(`/nDeleted the resource group: ${resourceGroupName}`);
  }).catch((err) => {
    throw (err);
  });
}

function createNetwork(){
  let subnetObj;
  return createVnet().then((vnet) => {
    return networkClient.subnets.get(resourceGroupName, vnetName, subnetName);
  }).then((subnet) => {
    subnetObj = subnet;
    return createPublicIP();
  }).then((ip) => {
    return createNIC(subnetObj, ip);
  }).catch((err) => {
    throw(err)}
  );
}

function createVnet() {
  let vnetParameters = {
    location: location,
    addressSpace: {
      addressPrefixes: ['10.0.0.0/16']
    },
    dhcpOptions: {
      dnsServers: ['10.1.1.1', '10.1.2.4']
    },
    subnets: [{ name: subnetName, addressPrefix: '10.0.0.0/24' }],
  };
  console.log(`\n5.Creating vnet: ${vnetName} with subnet: ${subnetName}`);
  return networkClient.virtualNetworks.createOrUpdate(resourceGroupName, vnetName, vnetParameters);
}

function createPublicIP() {
  let publicIPParameters = {
    location: location,
    publicIPAllocationMethod: 'Dynamic',
    dnsSettings: {
      domainNameLabel: domainNameLabel
    }
  };
  console.log('\n6.Creating public IP: ' + publicIPName);
  return networkClient.publicIPAddresses.createOrUpdate(resourceGroupName, publicIPName, publicIPParameters);
}

function createNIC(subnetInfo, publicIPInfo) {
  let nicParameters = {
    location: location,
    ipConfigurations: [
      {
        name: ipConfigName,
        privateIPAllocationMethod: 'Dynamic',
        subnet: subnetInfo,
        publicIPAddress: publicIPInfo
      }
    ]
  };
  console.log('\n7.Creating Network Interface: ' + networkInterfaceName);
  return networkClient.networkInterfaces.createOrUpdate(resourceGroupName, networkInterfaceName, nicParameters);
}

function createVirtualMachine(nicId) {
  let vmParameters = {
    location: location,
    osProfile: {
      computerName: vmName,
      adminUsername: adminUsername,
      adminPassword: adminPassword,
      // Key Vault Critical part
      secrets: [{
        sourceVault: {
            id: vaultObj.id,
        },
        vaultCertificates: [{
            certificateUrl: certificateSecretObj.id
        }]
    }]
    },
    hardwareProfile: {
      vmSize: 'Basic_A0'
    },
    storageProfile: {
      imageReference: {
        publisher: publisher,
        offer: offer,
        sku: sku,
        version: "latest"
      }
    },
    networkProfile: {
      networkInterfaces: [
        {
          id: nicId,
          primary: true
        }
      ]
    }
  };
  console.log('\n8.Creating Virtual Machine: ' + vmName);
  console.log('\n VM create parameters: ' + util.inspect(vmParameters, { depth: null }));
  return computeClient.virtualMachines.createOrUpdate(resourceGroupName, vmName, vmParameters);
}

function print_item(resource) {
  if (resource.name) console.log(`\tName: ${resource.name}`);
  if (resource.id) console.log(`\tId: ${resource.id}`);
  if (resource.location) console.log(`\tLocation: ${resource.location}`);
  if (resource.properties && resource.properties.provisioningState) console.log(`\t${resource.properties.provisioningState}`);
}

function _validateEnvironmentVariables() {
  var envs = [];
  if (!process.env['CLIENT_ID']) envs.push('CLIENT_ID');
  if (!process.env['DOMAIN']) envs.push('DOMAIN');
  if (!process.env['APPLICATION_SECRET']) envs.push('APPLICATION_SECRET');
  if (!process.env['AZURE_SUBSCRIPTION_ID']) envs.push('AZURE_SUBSCRIPTION_ID');
  if (envs.length > 0) {
    throw new Error(util.format('please set/export the following environment variables: %s', envs.toString()));
  }
}

function _generateRandomId(prefix, exsitIds) {
  var newNumber;
  while (true) {
    newNumber = prefix + Math.floor(Math.random() * 10000);
    if (!exsitIds || !(newNumber in exsitIds)) {
      break;
    }
  }
  return newNumber;
}