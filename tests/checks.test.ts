import { Octokit, RequestError } from "octokit";
import { beforeAll, describe, test } from "vitest";
import _ from 'lodash';
import 'lodash.product';
import { createAppAuth } from "@octokit/auth-app";
import { setTimeout } from 'node:timers/promises';

const apptokit = new Octokit({
  authStrategy: createAppAuth,
  auth: {
    appId: 1178750,
    privateKey: process.env.GITHUB_APP_PRIVATE_KEY,
    installationId: 65717473
  }
});

const tokentokit = new Octokit({
  auth: process.env.GITHUB_TOKEN
});

const statuses = [
  'queued',
  'in_progress',
  'completed',
  // Only GitHub Actions can set a status of waiting, pending, or requested.
  // 'waiting',
  // 'requested',
  // 'pending',
] as const;

const conclusions = [
  'action_required',
  'cancelled',
  'failure',
  'neutral',
  'success',
  'skipped',
  // You cannot change a check run conclusion to stale, only GitHub can set this.
  // 'stale', 
  'timed_out',
] as const;

const matrix = _.product(statuses, conclusions) as [typeof statuses[number], typeof conclusions[number]][];

const { data: main } = await tokentokit.rest.git.getRef({
  owner: '0x5b-org',
  repo: 'test-github-checks',
  ref: 'heads/main'
});

const rulesets = await tokentokit.paginate(tokentokit.rest.repos.getRepoRulesets, {
  owner: '0x5b-org',
  repo: 'test-github-checks',
  includes_parents: false
});

const branches = await tokentokit.paginate(tokentokit.rest.repos.listBranches, {
  owner: '0x5b-org',
  repo: 'test-github-checks'
});

let featureBranchSha: string;

// Ensure feature branch
beforeAll(async () => {
  const { data: mainTree } = await tokentokit.rest.git.getTree({
    owner: '0x5b-org',
    repo: 'test-github-checks',
    tree_sha: main.object.sha
  });

  const { data: tree } = await tokentokit.rest.git.createTree({
    owner: '0x5b-org',
    repo: 'test-github-checks',
    base_tree: mainTree.sha,
    tree: [
      {
        path: 'test_file',
        content: Buffer.from('Hello World!').toString('base64'),
        mode: '100644',
      }
    ]
  });

  const { data: commit } = await tokentokit.rest.git.createCommit({
    owner: '0x5b-org',
    repo: 'test-github-checks',
    message: 'Create feature branch',
    tree: tree.sha,
    parents: [main.object.sha]
  });

  if (branches.find(branch => branch.name === 'checks/feature')) {
    await tokentokit.rest.git.updateRef({
      owner: '0x5b-org',
      repo: 'test-github-checks',
      ref: 'heads/checks/feature',
      sha: commit.sha,
      force: true
    })
  } else {
    await tokentokit.rest.git.createRef({
      owner: '0x5b-org',
      repo: 'test-github-checks',
      ref: 'refs/heads/checks/feature',
      sha: commit.sha
    });
  }

  featureBranchSha = commit.sha;
});

describe.concurrent.for(matrix)('Check %s, %s', async ([status, conclusion]) => {
  // Cleanup
  beforeAll(async ({ }) => {
    // Delete branch
    const branch = branches.find(branch => branch.name === `checks/${status}/${conclusion}/main`);
    if (branch) {
      await apptokit.rest.git.deleteRef({
        owner: '0x5b-org',
        repo: 'test-github-checks',
        ref: `heads/${branch.name}`
      });
    }

    // Wait 5s for branch to be deleted
    await setTimeout(5_000);
  }, 90_000);

  // Setup
  beforeAll(async () => {
    // Upsert ruleset
    const ruleset = {
      owner: '0x5b-org',
      repo: 'test-github-checks',
      name: `Checks ${status} ${conclusion}`,
      target: 'branch',
      enforcement: 'active',
      conditions: {
        ref_name: {
          include: [`refs/heads/checks/${status}/${conclusion}/main`],
          exclude: []
        }
      },
      rules: [
        {
          type: 'required_status_checks',
          parameters: {
            strict_required_status_checks_policy: false,
            do_not_enforce_on_create: true,
            required_status_checks: [
              {
                context: `${status}/${conclusion}`,
                integration_id: 1178750
              }
            ]
          }
        }
      ]
    } satisfies Parameters<Octokit['rest']['repos']['createRepoRuleset']>[0];

    const rulesetId = rulesets.find(r => r.name === ruleset.name)?.id;
    if (rulesetId) await apptokit.rest.repos.updateRepoRuleset({ ...ruleset, ruleset_id: rulesetId });
    else await apptokit.rest.repos.createRepoRuleset(ruleset);
  
    // Create branch
    await tokentokit.rest.git.createRef({
      owner: '0x5b-org',
      repo: 'test-github-checks',
      ref: `refs/heads/checks/${status}/${conclusion}/main`,
      sha: main.object.sha
    });

    // Create check on feature branch
    await apptokit.rest.checks.create({
      owner: '0x5b-org',
      repo: 'test-github-checks',
      head_sha: featureBranchSha,
      name: `${status}/${conclusion}`,
      status,
      conclusion
    });
  }, 40_000);

  test('force update the branch', async ({ expect }) => {
    let result = 'success';
    
    try {
      await tokentokit.rest.git.updateRef({
        owner: '0x5b-org',
        repo: 'test-github-checks',
        ref: `heads/checks/${status}/${conclusion}/main`,
        sha: featureBranchSha,
        force: true
      });
    } catch (err) {
      expect(err).toBeInstanceOf(RequestError);
      if (err instanceof RequestError) result = err.message;
    }

    expect(result).toMatchSnapshot();
  });
});
