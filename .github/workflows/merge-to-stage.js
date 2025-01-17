const {
  slackNotification,
  getLocalConfigs,
  isWithinRCP,
  pulls: { addLabels, addFiles, getChecks, getReviews },
} = require('./helpers.js');

// Run from the root of the project for local testing: node --env-file=.env .github/workflows/merge-to-stage.js
const PR_TITLE = '[Release] Stage to Main';
const SEEN = {};
const REQUIRED_APPROVALS = process.env.REQUIRED_APPROVALS || 2;
const STAGE = 'stage';
const PROD = 'main';
const LABELS = {
  highPriority: 'high priority',
  readyForStage: 'Ready for Stage',
  SOTPrefix: 'SOT',
};
const TEAM_MENTIONS = [
  '@adobecom/miq-sot',
  '@adobecom/bacom-sot',
  '@adobecom/homepage-sot',
  '@adobecom/creative-cloud-sot',
  '@adobecom/document-cloud-sot',
];
const SLACK = {
  merge: ({ html_url, number, title }) =>
    `:merged: PR merged to stage: <${html_url}|${number}: ${title}>.`,
  openedSyncPr: ({ html_url, number }) =>
    `:fast_forward: Created <${html_url}|Stage to Main PR ${number}>`,
};

let github, owner, repo;

let body = `
## common base root URLs
**Homepage :** https://www.stage.adobe.com/
**BACOM:** https://business.stage.adobe.com/fr/
**CC:** https://www.stage.adobe.com/creativecloud.html
**Blog:** https://blog.stage.adobe.com/
**Acrobat:** https://www.stage.adobe.com/acrobat/online/sign-pdf.html

**Milo:**
- Before: https://main--milo--adobecom.hlx.live/?martech=off
- After: https://stage--milo--adobecom.hlx.live/?martech=off
`;

const isHighPrio = (labels) => labels.includes(LABELS.highPriority);

const hasFailingChecks = (checks) =>
  checks.some(
    ({ conclusion, name }) =>
      name !== 'merge-to-stage' && conclusion === 'failure'
  );

const getPRs = async () => {
  let prs = await github.rest.pulls
    .list({ owner, repo, state: 'open', per_page: 100, base: STAGE })
    .then(({ data }) => data);
  await Promise.all(prs.map((pr) => addLabels({ pr, github, owner, repo })));
  prs = prs.filter((pr) => pr.labels.includes(LABELS.readyForStage));
  await Promise.all([
    ...prs.map((pr) => addFiles({ pr, github, owner, repo })),
    ...prs.map((pr) => getChecks({ pr, github, owner, repo })),
    ...prs.map((pr) => getReviews({ pr, github, owner, repo })),
  ]);

  prs = prs.filter(({ checks, reviews, number, title }) => {
    if (hasFailingChecks(checks)) {
      console.log(`Skipping ${number}: ${title} due to failing checks`);
      return false;
    }

    const approvals = reviews.filter(({ state }) => state === 'APPROVED');
    if (approvals.length < REQUIRED_APPROVALS) {
      console.log(`Skipping ${number}: ${title} due to insufficient approvals`);
      return false;
    }

    return true;
  });

  return prs.reverse(); // OLD PRs first
};

const merge = async ({ prs }) => {
  console.log(`Merging ${prs.length || 0} PRs that are ready... `);

  for await (const { number, files, html_url, title } of prs) {
    try {
      if (files.some((file) => SEEN[file])) {
        console.log(`Skipping ${number}: ${title} due to overlap in files.`);
        continue;
      }
      files.forEach((file) => (SEEN[file] = true));
      if (!process.env.LOCAL_RUN) {
        await github.rest.pulls.merge({
          owner,
          repo,
          pull_number: number,
          merge_method: 'squash',
        });
      }
      body = `- ${html_url}\n${body}`;
      await slackNotification(
        SLACK.merge({
          html_url,
          number,
          title,
        })
      );
      await new Promise((resolve) => setTimeout(resolve, 5000));
    } catch (error) {
      console.log(`Error merging ${number}: ${title}`, error.message);
    }
  }
};

const getStageToMainPR = () =>
  github.rest.pulls
    .list({ owner, repo, state: 'open', base: PROD })
    .then(({ data } = {}) => data.find(({ title } = {}) => title === PR_TITLE))
    .then((pr) => pr && addLabels({ pr, github, owner, repo }))
    .then((pr) => pr && addFiles({ pr, github, owner, repo }))
    .then((pr) => {
      pr?.files.forEach((file) => (SEEN[file] = true));
      return pr;
    });

const openStageToMainPR = async () => {
  const { data: comparisonData } = await github.rest.repos.compareCommits({
    owner,
    repo,
    base: PROD,
    head: STAGE,
  });

  for (const commit of comparisonData.commits) {
    const { data: pullRequestData } =
      await github.rest.repos.listPullRequestsAssociatedWithCommit({
        owner,
        repo,
        commit_sha: commit.sha,
      });

    for (const pr of pullRequestData) {
      if (!body.includes(pr.html_url)) body = `- ${pr.html_url}\n${body}`;
    }
  }

  try {
    const {
      data: { html_url, number },
    } = await github.rest.pulls.create({
      owner,
      repo,
      title: PR_TITLE,
      head: STAGE,
      base: PROD,
      body,
    });

    await github.rest.issues.createComment({
      owner,
      repo,
      issue_number: number,
      body: `Testing can start ${TEAM_MENTIONS.join(' ')}`,
    });

    await slackNotification(SLACK.openedSyncPr({ html_url, number }));
  } catch (error) {
    if (error.message.includes('No commits between main and stage'))
      return console.log('No new commits, no stage->main PR opened');
    throw error;
  }
};

const main = async (params) => {
  github = params.github;
  owner = params.context.repo.owner;
  repo = params.context.repo.repo;
  if (isWithinRCP()) return console.log('Stopped, within RCP period.');

  try {
    const stageToMainPR = await getStageToMainPR();
    console.log('has Stage to Main PR:', !!stageToMainPR);
    if (stageToMainPR) body = stageToMainPR.body;
    if (stageToMainPR?.labels.some((label) => label.includes(LABELS.SOTPrefix)))
      return console.log('PR exists & testing started. Stopping execution.');
    const prs = await getPRs();
    await merge({ prs: prs.filter(({ labels }) => isHighPrio(labels)) });
    await merge({ prs: prs.filter(({ labels }) => !isHighPrio(labels)) });
    if (!stageToMainPR) await openStageToMainPR();
    if (stageToMainPR && body !== stageToMainPR.body) {
      console.log("Updating PR's body...");
      await github.rest.pulls.update({
        owner,
        repo,
        pull_number: stageToMainPR.number,
        body: body,
      });
    }
    console.log('Process successfully executed.');
  } catch (error) {
    console.error(error);
  }
};

if (process.env.LOCAL_RUN) {
  const { github, context } = getLocalConfigs();
  main({
    github,
    context,
  });
}

module.exports = main;
