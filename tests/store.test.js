import assert from 'node:assert/strict'
import { it } from 'node:test'

import { ciSearchLink, DEFAULTS, deployJenkinsLink, jenkinsJobUrl, JENKINS_TEMPLATE, normalise, parseList, parseRepos, skipsJenkins } from '../lib/store.js'

it('normalises settings', () => {
  assert.deepEqual(normalise(undefined), DEFAULTS)
  assert.deepEqual(normalise({ token: ' x ', extraBots: ['Jenkins', 3, ''], refreshMinutes: -5 }), {
    token: 'x', extraBots: ['jenkins'], refreshMinutes: 15, notify: true, jenkinsUser: '', jenkinsToken: '', watchedRepos: [], claudeKey: '', claudeModel: 'claude-sonnet-5', claudeAuto: false,
  })
})

it('reads watched repos: bare names are gdncomm, URLs are accepted, junk is dropped', () => {
  assert.deepEqual(
    parseRepos(['product-feed', 'Acme/API', 'https://github.com/gdncomm/seo-backend/', 'gdncomm/product-feed', 'x y', 'repo:evil', 'a/b/c']),
    ['gdncomm/product-feed', 'acme/api', 'gdncomm/seo-backend', 'a/b'],
  )
  assert.deepEqual(normalise({ watchedRepos: ['product-feed', 7] }).watchedRepos, ['gdncomm/product-feed'])
})

it('parses a comma/newline list', () => {
  assert.deepEqual(parseList('a, b\n c,,'), ['a', 'b', 'c'])
})

it('builds the Jenkins job link in the repo\'s team folder', () => {
  assert.equal(
    jenkinsJobUrl(JENKINS_TEMPLATE, { repo: 'gdncomm/product-feed', number: 152 }, 'TRFCEE'),
    'https://jenkins-build-ci-2.gdn-app.com/job/GitHub/job/gdncomm/job/GDN/job/TRFCEE/job/product-feed/job/PR-152/',
  )
  assert.equal(
    jenkinsJobUrl(JENKINS_TEMPLATE, { repo: 'gdncomm/seo-backend', number: 7 }, 'SEO'),
    'https://jenkins-build-ci-2.gdn-app.com/job/GitHub/job/gdncomm/job/GDN/job/SEO/job/seo-backend/job/PR-7/',
  )
  assert.equal(jenkinsJobUrl(JENKINS_TEMPLATE, { repo: 'gdncomm/seo-backend', number: 7 }, undefined), null, 'no folder: no guess')
  assert.equal(jenkinsJobUrl('', { repo: 'o/r', number: 1 }, 'X'), null)
  // prod / non-prod Jenkins never report PR builds and aren't on the CI host
  assert.equal(jenkinsJobUrl(JENKINS_TEMPLATE, { repo: 'gdncomm/prod-deployment-gdn-product-feed', number: 33 }, 'X'), null)
  assert.equal(jenkinsJobUrl(JENKINS_TEMPLATE, { repo: 'gdncomm/nonprod-rundeck-gdn-preprod', number: 46 }, 'X'), null)
  assert.equal(ciSearchLink({ repo: 'gdncomm/seo-backend' }), 'https://jenkins-build-ci-2.gdn-app.com/search/?q=seo-backend')
  assert.equal(ciSearchLink({ repo: 'gdncomm/prod-x' }), null)
})

it('links deployment repos to the Jenkins that runs them', () => {
  assert.deepEqual(deployJenkinsLink({ repo: 'gdncomm/prod-deployment-gdn-product-feed' }), {
    host: 'jenkins-prod-deploy.gdn-app.com', url: 'https://jenkins-prod-deploy.gdn-app.com/search/?q=prod-deployment-gdn-product-feed',
  })
  assert.equal(deployJenkinsLink({ repo: 'gdncomm/prod-infra-gdn-traffic-tracker-aggregator-mongo-updates' })?.host, 'jenkins-prod-infra.gdn-app.com')
  assert.equal(deployJenkinsLink({ repo: 'gdncomm/nonprod-rundeck-gdn-preprod' })?.host, 'jenkins-np-deploy.gdn-app.com')
  assert.equal(deployJenkinsLink({ repo: 'gdncomm/product-feed' }), null)
})

it('never looks up or links Jenkins for cucumber-* automation repos', () => {
  assert.equal(skipsJenkins({ repo: 'gdncomm/cucumber-seo-backend' }), true)
  assert.equal(skipsJenkins({ repo: 'gdncomm/seo-backend' }), false)
  assert.equal(jenkinsJobUrl(JENKINS_TEMPLATE, { repo: 'gdncomm/cucumber-seo-backend', number: 3 }, 'TRFCEE'), null)
  assert.equal(ciSearchLink({ repo: 'gdncomm/cucumber-seo-backend' }), null)
})
