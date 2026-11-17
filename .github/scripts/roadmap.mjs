import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const organization = 'N-Zik-Group';
const projectNumber = 1;
const assignee = 'NEVARLeVrai';
const statuses = ['Backlogs', 'In Progress', 'Done'];
export const repositories = new Set([
  'N-Zik-Theme-Store', 'N-Zik', 'DiscordRPC', 'Better-Lyrics',
  'Next-Visualizer', 'N-Zik-Website', 'N-Zik-Desktop-Compagnon',
].map(name => `${organization}/${name}`));

export async function collect(load, page = null) {
  const results = [];
  const cursors = new Set();
  for (;;) {
    page ??= await load(null);
    if (!Array.isArray(page.nodes)) throw new Error('Missing GitHub connection');
    results.push(...page.nodes.filter(node => node !== null));
    if (!page.pageInfo.hasNextPage) return results;
    const cursor = page.pageInfo.endCursor;
    if (!cursor || cursors.has(cursor)) throw new Error('Invalid GitHub pagination cursor');
    cursors.add(cursor);
    page = await load(cursor);
  }
}

const page = 'pageInfo { hasNextPage endCursor }';
const repository = 'repository { nameWithOwner }';
const lifecycle = `id number closedAt ${repository}
  reopen: timelineItems(last: 1, itemTypes: [REOPENED_EVENT]) {
    nodes { ... on ReopenedEvent { id createdAt } }
  }`;
const content = `__typename
  ... on Issue { issueState: state parent { id } ${lifecycle} }
  ... on PullRequest { pullState: state ${lifecycle} }`;
const cardFields = `id isArchived project { id }
  status: fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { optionId updatedAt } }`;
const card = `${cardFields} content { ${content} }`;
const subIssues = `subIssues(first: 30, after: $cursor) { nodes { id number ${repository} } ${page} }`;
// Keep references to closed PRs so reopening a previously linked PR does not count as a new link.
const links = `links: closedByPullRequestsReferences(first: 30, after: $cursor, includeClosedPrs: true) {
  nodes { id } ${page}
}`;
const firstRelationships = `${subIssues} ${links}`.replaceAll(', after: $cursor', '');

function normalizeContent(item) {
  return item ? { ...item, state: item.issueState ?? item.pullState } : item;
}

function normalizeCard(value) {
  return { ...value, content: normalizeContent(value.content) };
}

export class GitHub {
  constructor(token, { repositoryToken, repo, fetcher = fetch } = {}) {
    if (!token) throw new Error('Missing ROADMAP_TOKEN');
    this.token = token;
    this.repositoryToken = repositoryToken;
    this.repo = repo;
    this.fetch = fetcher;
  }

  async request(path, method, body) {
    const token = path === '/graphql' ? this.token : this.repositoryToken;
    if (!token) throw new Error('Missing caller GITHUB_TOKEN');
    const response = await this.fetch(`https://api.github.com${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`GitHub ${method} ${path} returned HTTP ${response.status}`);
    const result = await response.json();
    if (result.errors?.length) {
      throw new Error(`GitHub GraphQL: ${result.errors.map(error => error.message).join('; ')}`);
    }
    return result;
  }

  async graphql(query, variables) {
    return (await this.request('/graphql', 'POST', { query, variables })).data;
  }

  async project(repo) {
    const { organization: owner, repository: target } = await this.graphql(`
      query RoadmapProject($owner: String!, $number: Int!, $repo: String!) {
        organization(login: $owner) {
          projectV2(number: $number) {
            id number closed viewerCanUpdate field(name: "Status") {
              ... on ProjectV2SingleSelectField { id options { id name } }
            }
          }
        }
        repository(owner: $owner, name: $repo) { nameWithOwner }
      }`, { owner: organization, number: projectNumber, repo: repo.split('/')[1] });
    const project = owner?.projectV2;
    if (project?.number !== projectNumber || !project.id || project.closed || target?.nameWithOwner !== repo) {
      throw new Error(`Could not validate ${repo} and ${organization} project ${projectNumber}`);
    }
    if (!project.viewerCanUpdate) throw new Error(`ROADMAP_TOKEN cannot update project ${projectNumber}`);
    const options = {};
    for (const name of statuses) {
      const matching = project.field?.options.filter(option => option.name === name);
      if (!project.field?.id || matching?.length !== 1 || !matching[0].id) {
        throw new Error(`Expected a single Status option named ${name}`);
      }
      options[name] = matching[0].id;
    }
    return { id: project.id, field: project.field.id, options };
  }

  async item(repo, number) {
    const data = await this.graphql(`
      query RoadmapContent($owner: String!, $repo: String!, $number: Int!) {
        repository(owner: $owner, name: $repo) { issueOrPullRequest(number: $number) { ${content} } }
      }`, { owner: organization, repo: repo.split('/')[1], number });
    return normalizeContent(data.repository?.issueOrPullRequest);
  }

  async board(project) {
    const cards = await collect(async cursor => {
      const { node } = await this.graphql(`
        query RoadmapBoard($id: ID!, $cursor: String) {
          node(id: $id) { ... on ProjectV2 {
            items(first: 30, after: $cursor) {
              nodes { ${cardFields} content { ${content} ... on Issue { ${firstRelationships} } } }
              ${page}
            }
          } }
        }`, { id: project, cursor });
      return node.items;
    });
    return cards.map(normalizeCard);
  }

  async cardFor(project, item) {
    const membership = `projectItems(first: 30, after: $cursor, includeArchived: true) {
      nodes { ${card} } ${page}
    }`;
    const cards = await collect(async cursor => {
      const { node } = await this.graphql(`
        query RoadmapMembership($id: ID!, $cursor: String) {
          node(id: $id) {
            ... on Issue { ${membership} }
            ... on PullRequest { ${membership} }
          }
        }`, { id: item, cursor });
      return node.projectItems;
    });
    const match = cards.find(value => value.project.id === project);
    return match && normalizeCard(match);
  }

  async relationshipsPage(id, selection, cursor) {
    const { node } = await this.graphql(`
      query RoadmapRelationships($id: ID!, $cursor: String) {
        node(id: $id) { ... on Issue { ${selection} } }
      }`, { id, cursor });
    return node;
  }

  async activeLinks(item) {
    return (await collect(async cursor => (await this.relationshipsPage(item.id, links, cursor)).links))
      .map(pr => pr.id);
  }

  async relationships(item) {
    return {
      children: await collect(async cursor => (await this.relationshipsPage(item.id, subIssues, cursor)).subIssues, item.subIssues),
      links: (await collect(async cursor => (await this.relationshipsPage(item.id, links, cursor)).links, item.links))
        .map(pr => pr.id),
    };
  }

  async add(project, item) {
    await this.graphql(`
      mutation RoadmapAdd($project: ID!, $item: ID!) {
        addProjectV2ItemById(input: {projectId: $project, contentId: $item}) { item { id } }
      }`, { project, item: item.id });
  }

  async setStatus(project, id, status) {
    await this.graphql(`
      mutation RoadmapSetStatus($project: ID!, $item: ID!, $field: ID!, $option: String!) {
        updateProjectV2ItemFieldValue(input: {
          projectId: $project, itemId: $item, fieldId: $field, value: {singleSelectOptionId: $option}
        }) { projectV2Item { id } }
      }`, { project: project.id, item: id, field: project.field, option: project.options[status] });
  }

  repositoryIssuePath(item) {
    if (!repositories.has(this.repo) || repoOf(item) !== this.repo) {
      throw new Error('Repository operation outside the caller repository');
    }
    return `/repos/${this.repo}/issues/${item.number}`;
  }

  async assign(item) {
    const path = this.repositoryIssuePath(item);
    const assigned = result => result.assignees.some(user => user.login.toLowerCase() === assignee.toLowerCase());
    if (assigned(await this.request(path, 'GET'))) return;
    const updated = await this.request(`${path}/assignees`, 'POST', { assignees: [assignee] });
    if (!assigned(updated)) throw new Error(`GitHub did not assign ${assignee} to ${path}`);
  }

  async close(item) {
    if (item.__typename !== 'Issue') throw new Error('Only issues can be closed as completed');
    await this.request(this.repositoryIssuePath(item), 'PATCH', { state: 'closed', state_reason: 'completed' });
  }
}

const repoOf = item => item?.repository?.nameWithOwner;
const reopenEvent = item => item.reopen?.nodes[0];
const reopenId = item => reopenEvent(item)?.id ?? null;
const option = value => value.status?.optionId ?? null;
const statusChangedAfter = (value, time) => Date.parse(value.status?.updatedAt) > Date.parse(time);
const isClosed = item => ['CLOSED', 'MERGED'].includes(item.state);
const tracked = item => repositories.has(repoOf(item)) && ['Issue', 'PullRequest'].includes(item.__typename);
const label = item => `${repoOf(item)}#${item.number}`;

function isCurrent(value, original, project) {
  return value?.project.id === project.id && !value.isArchived &&
    tracked(value.content) && value.content.id === original.id && repoOf(value.content) === repoOf(original);
}

function eventMatches(item, action, payload) {
  if (action === 'closed') {
    return isClosed(item) &&
      Date.parse(payload.closed_at) === Date.parse(item.closedAt) &&
      (item.__typename === 'Issue' || Boolean(payload.merged) === (item.state === 'MERGED'));
  }
  if (action === 'reopened') {
    return item.state === 'OPEN' && Date.parse(reopenEvent(item)?.createdAt) === Date.parse(payload.updated_at);
  }
  return true;
}

export async function handleEvent(api, { repo, event, payload, rawNumber, dryRun }, log = console.log) {
  if (!repositories.has(repo)) throw new Error(`Repository outside roadmap scope: ${repo}`);
  const manual = event === 'workflow_dispatch';
  if (!manual && !['issues', 'pull_request_target'].includes(event)) throw new Error('Unsupported roadmap event');
  const action = manual ? 'manual' : payload.action;
  if (!['manual', 'opened', 'closed', 'reopened'].includes(action)) throw new Error('Unsupported roadmap action');
  const subject = event === 'issues' ? payload.issue : payload.pull_request;
  if (!manual && payload.repository?.full_name !== repo) throw new Error('Unexpected event repository');
  const numberText = manual ? rawNumber : String(subject?.number);
  const verifyOnly = manual && dryRun && numberText === '';
  const number = Number(numberText);
  if (!verifyOnly && (!/^[1-9][0-9]*$/.test(numberText) || number > 2_147_483_647)) {
    throw new Error('Expected a positive issue or pull request number');
  }
  const validateProject = async () => {
    const project = await api.project(repo);
    log(`Validated ${repo} and ${organization} project ${projectNumber}${dryRun ? ' (read-only)' : ''}`);
    return project;
  };
  if (verifyOnly) {
    await validateProject();
    return;
  }
  const item = await api.item(repo, number);
  if (!tracked(item) || repoOf(item) !== repo || item.number !== number ||
      (!manual && (subject.node_id !== item.id || item.__typename !== (event === 'issues' ? 'Issue' : 'PullRequest')))) {
    throw new Error(`Could not validate ${repo}#${number}`);
  }
  if (!eventMatches(item, action, subject)) return;
  const assign = async () => {
    if (action === 'closed') return;
    log(`${dryRun ? 'Would ensure' : 'Ensuring'} ${assignee} is assigned to ${label(item)}`);
    if (!dryRun) await api.assign(item);
  };
  const route = async () => routeItem(api, await validateProject(), item, action, subject, dryRun, log);
  const outcomes = await Promise.allSettled([assign(), route()]);
  const errors = outcomes.filter(outcome => outcome.status === 'rejected').map(outcome => outcome.reason.message);
  if (errors.length) throw new Error(errors.join('\n'));
}

async function routeItem(api, project, item, action, subject, dryRun, log) {
  let existing = await api.cardFor(project.id, item.id);
  if (action === 'closed') {
    if (!isCurrent(existing, item, project) || !eventMatches(existing.content, action, subject)) return;
    if (statusChangedAfter(existing, subject.closed_at)) return;
    await setStatus(api, project, existing, 'Done', dryRun, log);
    return;
  }
  if (action === 'reopened') {
    if (existing && (!isCurrent(existing, item, project) || !eventMatches(existing.content, action, subject))) return;
    if (existing && statusChangedAfter(existing, subject.updated_at)) return;
    if (!existing) {
      const live = dryRun ? item : await api.item(repoOf(item), item.number);
      if (live?.id !== item.id || repoOf(live) !== repoOf(item) || !eventMatches(live, action, subject)) return;
      await addAndInitialize(api, project, item, undefined, dryRun, log);
      if (dryRun) {
        log(`Would set ${label(item)} to In Progress`);
        return;
      }
      existing = await api.cardFor(project.id, item.id);
    }
    if (isCurrent(existing, item, project) && eventMatches(existing.content, action, subject)) {
      await setStatus(api, project, existing, 'In Progress', dryRun, log);
    }
    return;
  }
  await addAndInitialize(api, project, item, existing, dryRun, log, action === 'opened');
}

async function addAndInitialize(api, project, item, existing, dryRun, log, followLifecycle = false) {
  const initialStatus = live => {
    if (followLifecycle && isClosed(live)) return 'Done';
    if (followLifecycle && reopenId(live)) return 'In Progress';
    return 'Backlogs';
  };
  if (!existing) {
    log(`${dryRun ? 'Would add' : 'Adding'} ${label(item)} to project ${projectNumber}`);
    if (dryRun) {
      log(`Would initialize ${label(item)} to ${initialStatus(item)} if Status is empty`);
      return;
    }
    await api.add(project.id, item);
    existing = await api.cardFor(project.id, item.id);
    if (!existing) throw new Error(`Project card unavailable after adding ${label(item)}`);
  }
  if (isCurrent(existing, item, project) && option(existing) === null) {
    await setStatus(api, project, existing, initialStatus(existing.content), dryRun, log);
  }
}

async function setStatus(api, project, value, status, dryRun, log) {
  if (option(value) === project.options[status]) return;
  log(`${dryRun ? 'Would set' : 'Setting'} ${label(value.content)} to ${status}`);
  if (!dryRun) await api.setStatus(project, value.id, status);
}

export async function reconcile(api, { repo, previous, dryRun }, log = console.log) {
  if (!repositories.has(repo)) throw new Error(`Repository outside roadmap scope: ${repo}`);
  const project = await api.project(repo);
  if (previous && (previous.version !== 1 || previous.project !== project.id ||
      (previous.repo && previous.repo !== repo) ||
      !previous.cards || typeof previous.cards !== 'object' || Array.isArray(previous.cards))) {
    throw new Error('Invalid roadmap snapshot or project/repository mismatch');
  }
  const statusSchema = JSON.stringify([project.field, ...statuses.map(name => project.options[name])]);
  if (previous && (!previous.repo || previous.statusSchema !== statusSchema)) {
    log('The roadmap snapshot scope or Status configuration changed. Recording a fresh baseline.');
    previous = undefined;
  }
  const cards = (await api.board(project.id)).filter(value => value.project.id === project.id && tracked(value.content));
  const membership = new Set(cards.map(value => value.content.id));
  const localCards = cards.filter(value => repoOf(value.content) === repo);
  const next = { version: 1, project: project.id, repo, statusSchema, cards: Object.create(null) };
  log(`Validated ${organization} project ${projectNumber}. Tracking ${localCards.length} cards in ${repo}.`);
  if (!previous) log('No previous snapshot. Recording a baseline without changing existing cards.');
  for (const scan of localCards) {
    if (scan.isArchived) continue;
    const item = scan.content;
    const relationships = item.__typename === 'Issue' ? await api.relationships(item) : { children: [], links: [] };
    const children = relationships.children.filter(child => repositories.has(repoOf(child)));
    const prior = previous?.cards[scan.id];
    const snapshot = {
      status: option(scan), state: item.state, closedAt: item.closedAt, reopen: reopenId(item),
      children: children.map(child => child.id), links: relationships.links,
    };
    next.cards[scan.id] = snapshot;
    if (!previous) continue;

    const done = project.options.Done;
    const transitionedToDone = prior && prior.status !== done && snapshot.status === done;
    const newLinks = snapshot.links.filter(id => !prior?.links.includes(id));
    const needsInitialization = !prior && snapshot.status === null;
    const closed = prior && isClosed(item) && (prior.state !== item.state || prior.closedAt !== item.closedAt);
    const reopened = prior && item.state === 'OPEN' && snapshot.reopen && prior.reopen !== snapshot.reopen;
    const closeIssue = item.__typename === 'Issue' && item.state === 'OPEN' &&
      transitionedToDone && prior.reopen === snapshot.reopen;
    const applyLinks = item.state === 'OPEN' && newLinks.length > 0;
    const newChildren = children.filter(child => !membership.has(child.id) && !prior?.children.includes(child.id));
    if (!needsInitialization && !closed && !reopened && !closeIssue && !applyLinks && !newChildren.length) continue;

    const live = await api.cardFor(project.id, item.id);
    if (!isCurrent(live, item, project) || live.id !== scan.id) continue;
    const sameStatus = option(live) === snapshot.status && live.status?.updatedAt === scan.status?.updatedAt;
    const sameLifecycle = live.content.state === item.state && live.content.closedAt === item.closedAt &&
      reopenId(live.content) === snapshot.reopen;
    const activeLinks = applyLinks && live.content.state === 'OPEN' ? await api.activeLinks(live.content) : [];
    const activeNewLinks = newLinks.filter(id => activeLinks.includes(id));
    if (applyLinks) {
      // Observe vanished links only when they reappear. Retry active links if the card changed mid-scan.
      snapshot.links = snapshot.links.filter(id => !newLinks.includes(id) ||
        (activeNewLinks.includes(id) && sameStatus && sameLifecycle));
    }
    if (sameStatus && sameLifecycle) {
      const lifecycleTime = closed ? item.closedAt : reopenEvent(item)?.createdAt;
      if ((closed || reopened) && !statusChangedAfter(live, lifecycleTime)) {
        await setStatus(api, project, live, closed ? 'Done' : 'In Progress', dryRun, log);
      } else if (closeIssue) {
        log(`${dryRun ? 'Would close' : 'Closing'} ${label(item)} as completed`);
        if (!dryRun) await api.close(live.content);
      } else if (activeNewLinks.length) {
        await setStatus(api, project, live, 'In Progress', dryRun, log);
      } else if (needsInitialization) {
        await setStatus(api, project, live, 'Backlogs', dryRun, log);
      }
    } else if (closed || reopened) {
      // Re-evaluate against a consistent scan before consuming a lifecycle change.
      snapshot.state = prior.state;
      snapshot.closedAt = prior.closedAt;
      snapshot.reopen = prior.reopen;
    }
    for (const child of newChildren) {
      if (membership.has(child.id)) continue;
      const existing = await api.cardFor(project.id, child.id);
      if (!existing) {
        const current = await api.item(repoOf(child), child.number);
        if (!tracked(current) || current.__typename !== 'Issue' || current.id !== child.id ||
            repoOf(current) !== repoOf(child) || current.parent?.id !== item.id) {
          snapshot.children = snapshot.children.filter(id => id !== child.id);
          continue;
        }
        await addAndInitialize(api, project, current, undefined, dryRun, log);
      }
      membership.add(child.id);
    }
  }
  return next;
}

async function main() {
  const repo = process.env.GITHUB_REPOSITORY;
  const api = new GitHub(process.env.ROADMAP_TOKEN, { repo, repositoryToken: process.env.ROADMAP_REPOSITORY_TOKEN });
  const dryRun = process.env.ROADMAP_DRY_RUN === 'true';
  if (process.argv[2] === 'reconcile') {
    const stateFile = process.env.ROADMAP_STATE_FILE;
    let previous;
    try {
      previous = JSON.parse(await readFile(stateFile, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const next = await reconcile(api, { repo, previous, dryRun });
    if (!dryRun) await writeFile(stateFile, JSON.stringify(next) + '\n');
    return;
  }
  if (process.argv[2] !== 'event') throw new Error('Unsupported roadmap command');
  const payload = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'));
  await handleEvent(api, {
    repo, event: process.env.GITHUB_EVENT_NAME, payload,
    rawNumber: process.env.ROADMAP_ITEM_NUMBER ?? '', dryRun,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
