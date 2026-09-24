import assert from 'node:assert/strict'
import { it } from 'node:test'

import { DEFAULTS, deployJenkinsLink, jenkinsJobUrl, JENKINS_TEMPLATE, normalise, parseList } from '../lib/store.js'

it('normalises settings', () => {
  assert.deepEqual(normalise(undefined), DEFAULTS)
  assert.deepEqual(normalise({ token: ' x ', extraBots: ['Jenkins', 3, ''], refreshMinutes: -5 }), {
    token: 'x', extraBots: ['jenkins'], refreshMinutes: 15, notify: true, jenkinsTemplate: JENKINS_TEMPLATE, jenkinsUser: '', jenkinsToken: '',
  })
})

it('parses a comma/newline list', () => {
  assert.deepEqual(parseList('a, b\n c,,'), ['a', 'b', 'c'])
})

it('builds the Jenkins job link from the template', () => {
  assert.equal(
    jenkinsJobUrl(JENKINS_TEMPLATE, { repo: 'gdncomm/product-feed', number: 152 }),
    'https://jenkins-build-ci-2.gdn-app.com/job/GitHub/job/gdncomm/job/GDN/job/TRFCEE/job/product-feed/job/PR-152/',
  )
  assert.equal(jenkinsJobUrl('', { repo: 'o/r', number: 1 }), null)
  // prod / non-prod Jenkins never report PR builds and aren't on the CI host
  assert.equal(jenkinsJobUrl(JENKINS_TEMPLATE, { repo: 'gdncomm/prod-deployment-gdn-product-feed', number: 33 }), null)
  assert.equal(jenkinsJobUrl(JENKINS_TEMPLATE, { repo: 'gdncomm/nonprod-rundeck-gdn-preprod', number: 46 }), null)
  assert.notEqual(jenkinsJobUrl(JENKINS_TEMPLATE, { repo: 'gdncomm/product-feed', number: 1 }), null)
  assert.equal(normalise({ jenkinsTemplate: 'javascript:alert(1)' }).jenkinsTemplate, JENKINS_TEMPLATE, 'https only')
  assert.equal(normalise({ jenkinsTemplate: '' }).jenkinsTemplate, '', 'empty turns it off')
})

it('links deployment repos to the Jenkins that runs them', () => {
  assert.deepEqual(deployJenkinsLink({ repo: 'gdncomm/prod-deployment-gdn-product-feed' }), {
    host: 'jenkins-prod-deploy.gdn-app.com', url: 'https://jenkins-prod-deploy.gdn-app.com/search/?q=prod-deployment-gdn-product-feed',
  })
  assert.equal(deployJenkinsLink({ repo: 'gdncomm/prod-infra-gdn-traffic-tracker-aggregator-mongo-updates' })?.host, 'jenkins-prod-infra.gdn-app.com')
  assert.equal(deployJenkinsLink({ repo: 'gdncomm/nonprod-rundeck-gdn-preprod' })?.host, 'jenkins-np-deploy.gdn-app.com')
  assert.equal(deployJenkinsLink({ repo: 'gdncomm/product-feed' }), null)
})
