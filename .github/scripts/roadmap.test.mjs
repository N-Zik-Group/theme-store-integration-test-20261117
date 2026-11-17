import assert from 'node:assert/strict';
import test from 'node:test';
import { collect, GitHub, handleEvent, reconcile, repositories } from './roadmap.mjs';

const central = 'N-Zik-Group/N-Zik-Theme-Store';
const desktop = 'N-Zik-Group/N-Zik-Desktop-Compagnon';
const outside = 'N-Zik-Group/N-Zik-Desktop';
const project = { id: 'project-1', field: 'status', options: { Backlogs: 'backlog', 'In Progress': 'progress', Done: 'done' } };
const closedAt = '2026-11-15T19:00:00Z';
const reopenedAt = '2026-11-15T19:15:00Z';
const silent = () => {};

function item(number, { repo = central, kind = 'Issue', state = 'OPEN' } = {}) {
  return {
    __typename: kind, id: `node-${number}`, number, state,
    closedAt: state === 'OPEN' ? null : closedAt,
    repository: { nameWithOwner: repo },
    reopen: { nodes: [] },
  };
}

function card(content, status = null, isArchived = false, projectId = project.id) {
  return { content, status: { optionId: status }, isArchived, id: `card-${content.id}`, project: { id: projectId } };
}

function fixture(items, cards = []) {
  const writes = [];
  const members = new Map(cards.map(value => [value.content.id, value]));
  const edges = new Map();
  const assignees = new Map();
  const api = {
    project: async () => project,
    item: async (repo, number) => items.find(value => value.number === number && value.repository.nameWithOwner === repo),
    cardFor: async (_project, id) => members.get(id),
    board: async () => [...members.values()],
    relationships: async content => edges.get(content.id) ?? { children: [], links: [] },
    activeLinks: async content => edges.get(content.id)?.links ?? [],
    add: async (target, content) => {
      assert.equal(target, project.id);
      writes.push(['add', content.number]);
      members.set(content.id, card(content));
    },
    assign: async content => {
      const people = assignees.get(content.id) ?? new Set();
      if (!people.has('NEVARLeVrai')) {
        writes.push(['assign', content.number]);
        people.add('NEVARLeVrai');
      }
      assignees.set(content.id, people);
    },
    setStatus: async (target, id, status) => {
      assert.equal(target, project);
      writes.push(['status', id, status]);
      const value = [...members.values()].find(member => member.id === id);
      value.status.optionId = project.options[status];
    },
    close: async content => {
      writes.push(['close', content.number, 'COMPLETED']);
      content.state = 'CLOSED';
    },
  };
  return { api, writes, members, edges, assignees };
}

function event(subject, action, timestamp = action === 'closed' ? closedAt : reopenedAt) {
  const repo = subject.repository.nameWithOwner;
  const isIssue = subject.__typename === 'Issue';
  return {
    repo, event: isIssue ? 'issues' : 'pull_request_target',
    payload: {
      action, repository: { full_name: repo },
      [isIssue ? 'issue' : 'pull_request']: {
        node_id: subject.id, number: subject.number, updated_at: timestamp,
        closed_at: action === 'closed' ? timestamp : null, merged: subject.state === 'MERGED',
      },
    },
  };
}

const scan = (api, previous, dryRun = false, log = silent) => reconcile(api, { repo: central, previous, dryRun }, log);

test('the seven repositories are the complete routing scope', () => {
  assert.deepEqual([...repositories].sort(), [
    central, desktop, 'N-Zik-Group/N-Zik', 'N-Zik-Group/DiscordRPC',
    'N-Zik-Group/Better-Lyrics', 'N-Zik-Group/Next-Visualizer', 'N-Zik-Group/N-Zik-Website',
  ].sort());
});

test('opened desktop issue and fork PR are assigned and added once', async () => {
  for (const kind of ['Issue', 'PullRequest']) {
    const subject = item(1, { repo: desktop, kind });
    const { api, writes, members, assignees } = fixture([subject]);
    assignees.set(subject.id, new Set(['someone-else']));
    await handleEvent(api, event(subject, 'opened'), silent);
    members.get(subject.id).status.optionId = project.options['In Progress'];
    await handleEvent(api, event(subject, 'opened'), silent);
    assert.deepEqual(writes, [['assign', 1], ['add', 1], ['status', 'card-node-1', 'Backlogs']]);
    assert.deepEqual([...assignees.get(subject.id)], ['someone-else', 'NEVARLeVrai']);
  }
});

test('manual dispatch supports a single item and read-only repository preflight', async () => {
  const subject = item(1);
  const { api, writes } = fixture([subject]);
  const logs = [];
  const dispatch = { repo: central, event: 'workflow_dispatch', payload: {} };
  await handleEvent(api, { ...dispatch, rawNumber: '', dryRun: true }, line => logs.push(line));
  assert.match(logs.join('\n'), /project 1 \(read-only\)/);
  await handleEvent(api, { ...dispatch, rawNumber: '1', dryRun: true }, line => logs.push(line));
  assert.match(logs.join('\n'), /Would add N-Zik-Group\/N-Zik-Theme-Store#1/);
  assert.deepEqual(writes, []);
  await handleEvent(api, { ...dispatch, rawNumber: '1' }, silent);
  assert.deepEqual(writes.map(write => write[0]), ['assign', 'add', 'status']);
  for (const rawNumber of ['', '0', '1.5', '2147483648', '1;cmd']) {
    await assert.rejects(handleEvent(api, { ...dispatch, rawNumber }, silent), /positive/);
  }
});

test('rejects untracked repositories, mismatched events and unexpected content', async () => {
  const subject = item(1);
  const { api, writes } = fixture([subject]);
  const opened = event(subject, 'opened');
  await assert.rejects(handleEvent(api, { ...opened, repo: outside }, silent), /outside roadmap/);
  await assert.rejects(handleEvent(api, { ...opened, repo: desktop }, silent), /event repository/);
  opened.payload.issue.node_id = 'unrelated';
  await assert.rejects(handleEvent(api, opened, silent), /Could not validate/);
  await assert.rejects(reconcile(api, { repo: outside }, silent), /outside roadmap/);
  await assert.rejects(scan(api, { version: 1, project: 'another-project', cards: {} }), /project\/repository mismatch/);
  await assert.rejects(scan(api, { version: 1, project: project.id, repo: desktop, cards: {} }), /project\/repository mismatch/);
  assert.deepEqual(writes, []);
});

test('closes and merges update existing cards once and skip untracked, archived or missing cards', async () => {
  const subjects = [
    item(1, { state: 'CLOSED' }), item(2, { state: 'MERGED', kind: 'PullRequest' }),
    item(3, { state: 'CLOSED', kind: 'PullRequest' }), item(4, { state: 'CLOSED' }),
    item(5, { state: 'CLOSED' }), item(6, { state: 'CLOSED' }),
  ];
  const cards = [...subjects.slice(0, 3).map(subject => card(subject, 'progress')),
    card(subjects[3], 'progress', true), card(subjects[4], 'progress', false, 'other-project')];
  const { api, writes } = fixture(subjects, cards);
  for (const subject of subjects) {
    await handleEvent(api, event(subject, 'closed'), silent);
    await handleEvent(api, event(subject, 'closed'), silent);
  }
  assert.deepEqual(writes, [1, 2, 3].map(number => ['status', `card-node-${number}`, 'Done']));
});

test('stale close and reopen deliveries leave the current lifecycle alone', async () => {
  const subject = item(1);
  const { api, writes } = fixture([subject], [card(subject, 'backlog')]);
  subject.reopen.nodes = [{ id: 'reopening', createdAt: reopenedAt }];
  await handleEvent(api, event(subject, 'reopened'), silent);
  await handleEvent(api, event(subject, 'closed'), silent);
  await handleEvent(api, event(subject, 'reopened', closedAt), silent);
  subject.state = 'CLOSED';
  subject.closedAt = '2026-11-15T19:30:00Z';
  await handleEvent(api, event(subject, 'closed'), silent);
  await handleEvent(api, event(subject, 'reopened'), silent);
  assert.deepEqual(writes, [['assign', 1], ['status', 'card-node-1', 'In Progress']]);
});

test('replayed lifecycle events preserve a more recent project status', async () => {
  const closed = item(1, { state: 'CLOSED' });
  const reopened = item(2);
  reopened.reopen.nodes = [{ id: 'reopening', createdAt: reopenedAt }];
  const cards = [card(closed, 'progress'), card(reopened, 'backlog')];
  for (const value of cards) value.status.updatedAt = '2026-11-15T19:30:00Z';
  const { api, writes } = fixture([closed, reopened], cards);
  await handleEvent(api, event(closed, 'closed'), silent);
  await handleEvent(api, event(reopened, 'reopened'), silent);
  assert.deepEqual(writes, [['assign', 2]]);
});

test('an open delivery that runs after a close creates a card using live state after adding', async () => {
  const subject = item(1, { state: 'CLOSED' });
  const { api, writes } = fixture([subject]);
  await handleEvent(api, event(subject, 'closed'), silent);
  subject.state = 'OPEN';
  subject.closedAt = null;
  const add = api.add;
  api.add = async (...args) => {
    await add(...args);
    subject.state = 'CLOSED';
    subject.closedAt = closedAt;
  };
  await handleEvent(api, event(subject, 'opened'), silent);
  assert.deepEqual(writes, [['assign', 1], ['add', 1], ['status', 'card-node-1', 'Done']]);
});

test('a project failure does not block assignment for open or current reopen events', async () => {
  for (const action of ['opened', 'reopened']) {
    const subject = item(1);
    subject.reopen.nodes = [{ id: 'reopening', createdAt: reopenedAt }];
    const { api, writes } = fixture([subject]);
    api.project = async () => { throw new Error('Project access denied'); };
    await assert.rejects(handleEvent(api, event(subject, action), silent), /Project access denied/);
    assert.deepEqual(writes, [['assign', 1]]);
  }
});

test('a current reopen can recover missing cards and assignment', async () => {
  const subject = item(1, { kind: 'PullRequest', repo: desktop });
  const { api, writes } = fixture([subject]);
  subject.reopen.nodes = [{ id: 'reopening', createdAt: reopenedAt }];
  await handleEvent(api, event(subject, 'reopened'), silent);
  await handleEvent(api, event(subject, 'reopened'), silent);
  assert.deepEqual(writes, [
    ['assign', 1], ['add', 1], ['status', 'card-node-1', 'Backlogs'], ['status', 'card-node-1', 'In Progress'],
  ]);
});

test('the first scan only records existing cards and relationships', async () => {
  const done = item(1);
  const empty = item(2);
  const child = item(3);
  const { api, writes, edges } = fixture([done, empty, child], [card(done, 'done'), card(empty)]);
  edges.set(done.id, { children: [child], links: ['old-link'] });
  const baseline = await scan(api);
  await scan(api, baseline);
  assert.deepEqual(writes, []);
  assert.deepEqual(baseline.cards['card-node-1'].links, ['old-link']);
  assert.deepEqual(baseline.cards['card-node-1'].children, [child.id]);
});

test('new empty cards move to Backlogs and populated cards keep their status', async () => {
  const subjects = [item(1), item(2), item(3, { repo: outside }), item(4, { kind: 'PullRequest' })];
  const { api, writes, members } = fixture(subjects);
  const baseline = await scan(api);
  members.set(subjects[0].id, card(subjects[0]));
  members.set(subjects[1].id, card(subjects[1], 'progress'));
  members.set(subjects[2].id, card(subjects[2]));
  members.set(subjects[3].id, card(subjects[3]));
  const snapshot = await scan(api, baseline);
  await scan(api, snapshot);
  assert.deepEqual(writes, [
    ['status', 'card-node-1', 'Backlogs'], ['status', 'card-node-4', 'Backlogs'],
  ]);
  assert.equal(snapshot.cards['card-node-3'], undefined);
});

test('adds newly linked sub-issues once, skipping active, archived and out-of-scope cards', async () => {
  const [parent, child, existing, archived, external] = [
    item(1), item(2, { repo: desktop }), item(3), item(4), item(5, { repo: outside }),
  ];
  const { api, writes, edges } = fixture([parent, child, existing, archived, external], [
    card(parent, 'progress'), card(existing, 'backlog'), card(archived, null, true),
  ]);
  const baseline = await scan(api);
  child.parent = { id: parent.id };
  edges.set(parent.id, { children: [child, existing, archived, external], links: [] });
  const snapshot = await scan(api, baseline);
  await scan(api, snapshot);
  assert.deepEqual(writes, [['add', 2], ['status', 'card-node-2', 'Backlogs']]);
});

test('moving an open issue to Done closes it as completed; a PR and a reopened issue stay open', async () => {
  const [issue, reopened, pr] = [item(1), item(2), item(3, { kind: 'PullRequest' })];
  const cards = [issue, reopened, pr].map(subject => card(subject, 'progress'));
  const { api, writes } = fixture([issue, reopened, pr], cards);
  const baseline = await scan(api);
  for (const value of cards) value.status.optionId = 'done';
  reopened.reopen.nodes = [{ id: 'new-generation', createdAt: reopenedAt }];
  const snapshot = await scan(api, baseline);
  await scan(api, snapshot);
  assert.deepEqual(writes, [['close', 1, 'COMPLETED'], ['status', 'card-node-2', 'In Progress']]);
});

test('reconciliation recovers close, merge and reopen lifecycle events without a repository event', async () => {
  const [issue, pr, reopened] = [item(1), item(2, { kind: 'PullRequest' }), item(3, { state: 'CLOSED' })];
  const cards = [card(issue, 'backlog'), card(pr, 'progress'), card(reopened, 'done')];
  const { api, writes } = fixture([issue, pr, reopened], cards);
  const baseline = await scan(api);
  issue.state = 'CLOSED';
  issue.closedAt = closedAt;
  pr.state = 'MERGED';
  pr.closedAt = closedAt;
  reopened.state = 'OPEN';
  reopened.closedAt = null;
  reopened.reopen.nodes = [{ id: 'reopen-node', createdAt: reopenedAt }];
  const snapshot = await scan(api, baseline);
  await scan(api, snapshot);
  assert.deepEqual(writes, [
    ['status', 'card-node-1', 'Done'], ['status', 'card-node-2', 'Done'],
    ['status', 'card-node-3', 'In Progress'],
  ]);
});

test('each reconciliation updates only its own repository while adding verified cross-repository child cards', async () => {
  const local = item(1, { repo: desktop });
  const foreign = item(2);
  const child = { ...item(3), parent: { id: local.id } };
  const scanned = [card(local, 'progress'), card(foreign, 'progress')];
  const { api, writes, edges } = fixture([local, foreign, child], scanned);
  const baseline = await reconcile(api, { repo: desktop }, silent);
  assert.equal(baseline.repo, desktop);
  assert.deepEqual(Object.keys(baseline.cards), [scanned[0].id]);
  scanned.forEach(value => { value.status.optionId = 'done'; });
  edges.set(local.id, { children: [child], links: [] });
  await reconcile(api, { repo: desktop, previous: baseline }, silent);
  assert.deepEqual(writes, [['close', 1, 'COMPLETED'], ['add', 3], ['status', 'card-node-3', 'Backlogs']]);
});

test('reconciliation baselines new Status option IDs without closing open issues', async () => {
  const subject = item(1);
  const value = card(subject, 'done');
  const { api, writes } = fixture([subject], [value]);
  const baseline = await scan(api);
  api.project = async () => ({ ...project, field: 'new-status-field', options: { ...project.options, Done: 'new-done' } });
  value.status.optionId = 'new-done';
  const snapshot = await scan(api, baseline);
  await scan(api, snapshot);
  assert.deepEqual(writes, []);
  assert.notEqual(snapshot.statusSchema, baseline.statusSchema);
});

test('rechecks live project status before completing an issue', async () => {
  const subject = item(1);
  const scanned = card(subject, 'progress');
  const { api, writes } = fixture([subject], [scanned]);
  const baseline = await scan(api);
  scanned.status.optionId = 'done';
  api.cardFor = async () => card(subject, 'progress');
  await scan(api, baseline);
  assert.deepEqual(writes, []);
});

test('new PR links move open issue cards to In Progress only once', async () => {
  const [issue, closed] = [item(1), item(2, { state: 'CLOSED' })];
  const issueCard = card(issue, 'backlog');
  const { api, writes, edges } = fixture([issue, closed], [issueCard, card(closed, 'done')]);
  edges.set(issue.id, { children: [], links: ['old-link'] });
  const baseline = await scan(api);
  edges.set(issue.id, { children: [], links: ['old-link', 'new-link'] });
  edges.set(closed.id, { children: [], links: ['explicit-link'] });
  const snapshot = await scan(api, baseline);
  issueCard.status.optionId = 'backlog';
  await scan(api, snapshot);
  assert.deepEqual(writes, [['status', 'card-node-1', 'In Progress']]);
});

test('a first-seen open card with a PR link ends up In Progress in one scan', async () => {
  const subject = item(1);
  const { api, writes, edges, members } = fixture([subject]);
  const baseline = await scan(api);
  members.set(subject.id, card(subject));
  edges.set(subject.id, { children: [], links: ['new-link'] });
  const snapshot = await scan(api, baseline);
  await scan(api, snapshot);
  assert.deepEqual(writes, [['status', 'card-node-1', 'In Progress']]);
});

test('retries an active PR link after the live status differs from the scanned status', async () => {
  const subject = item(1);
  const scanned = card(subject, 'backlog');
  const { api, writes, edges } = fixture([subject], [scanned]);
  const baseline = await scan(api);
  edges.set(subject.id, { children: [], links: ['new-link'] });
  const cardFor = api.cardFor;
  api.cardFor = async () => card(subject, 'another-status');
  const pending = await scan(api, baseline);
  assert.deepEqual(pending.cards[scanned.id].links, []);
  assert.deepEqual(writes, []);
  api.cardFor = cardFor;
  scanned.status.optionId = 'another-status';
  await scan(api, pending);
  assert.deepEqual(writes, [['status', scanned.id, 'In Progress']]);
});

test('does not act on a PR link or sub-issue removed after the scan', async () => {
  const [subject, child] = [item(1), item(2)];
  const { api, writes, edges } = fixture([subject, child], [card(subject, 'backlog')]);
  const baseline = await scan(api);
  edges.set(subject.id, { children: [child], links: ['removed-link'] });
  api.activeLinks = async () => [];
  const snapshot = await scan(api, baseline);
  assert.deepEqual(snapshot.cards['card-node-1'].links, []);
  assert.deepEqual(snapshot.cards['card-node-1'].children, []);
  assert.deepEqual(writes, []);
});

test('read-only reconciliation reports each planned transition without writing', async () => {
  const [done, linked, empty, child] = [1, 2, 3, 4].map(number => item(number));
  const doneCard = card(done, 'progress');
  const { api, writes, edges, members } = fixture([done, linked, empty, child], [doneCard, card(linked, 'backlog')]);
  const baseline = await scan(api);
  const original = JSON.stringify(baseline);
  members.set(empty.id, card(empty));
  doneCard.status.optionId = 'done';
  child.parent = { id: linked.id };
  edges.set(linked.id, { children: [child], links: ['new-link'] });
  const logs = [];
  await scan(api, baseline, true, line => logs.push(line));
  assert.match(logs.join('\n'), /Would close .*#1 as completed/);
  assert.match(logs.join('\n'), /Would set .*#2 to In Progress/);
  assert.match(logs.join('\n'), /Would set .*#3 to Backlogs/);
  assert.match(logs.join('\n'), /Would add .*#4 to project 1/);
  assert.deepEqual(writes, []);
  assert.equal(JSON.stringify(baseline), original);
});

const connection = (nodes, endCursor = null) => ({ nodes, pageInfo: { endCursor, hasNextPage: endCursor !== null } });
const response = value => new Response(JSON.stringify(value));

test('paginates board cards and batched initial relationships', async () => {
  const requests = [];
  const api = new GitHub('mock', { fetcher: async (_url, { body }) => {
    const { query, variables } = JSON.parse(body);
    requests.push(variables);
    assert.match(query, /subIssues\(first: 30\)/);
    assert.match(query, /closedByPullRequestsReferences\(first: 30, includeClosedPrs: true\)/);
    const number = variables.cursor ? 2 : 1;
    const subject = { ...item(number), issueState: 'OPEN', subIssues: connection([]), links: connection([]) };
    return response({ data: { node: { items: connection([card(subject)], number === 1 ? 'next' : null) } } });
  } });
  const cards = await api.board(project.id);
  assert.deepEqual(cards.map(value => value.content.state), ['OPEN', 'OPEN']);
  assert.deepEqual(requests, [{ id: project.id, cursor: null }, { id: project.id, cursor: 'next' }]);
  await api.relationships(cards[0].content);
  assert.equal(requests.length, 2);
});

test('paginates both relationships independently after the batched project page', async () => {
  const calls = [];
  const api = new GitHub('mock', { fetcher: async (_url, { body }) => {
    const { query, variables } = JSON.parse(body);
    calls.push(variables);
    if (query.includes('subIssues')) {
      return response({ data: { node: { subIssues: connection([item(3)]) } } });
    }
    return response({ data: { node: { links: connection([{ id: 'pr-2' }]) } } });
  } });
  const relationships = await api.relationships({
    ...item(1), subIssues: connection([item(2)], 'child-next'), links: connection([{ id: 'pr-1' }], 'pr-next'),
  });
  assert.deepEqual(relationships.children.map(value => value.number), [2, 3]);
  assert.deepEqual(relationships.links, ['pr-1', 'pr-2']);
  assert.deepEqual(calls.map(call => call.cursor), ['child-next', 'pr-next']);
  await assert.rejects(collect(async () => connection([], 'repeated')), /pagination cursor/);
});

test('validates project number, status options, repository and write permission', async () => {
  const result = {
    organization: {
      projectV2: {
        id: project.id, number: 1, closed: false, viewerCanUpdate: true,
        field: { id: project.field, options: Object.entries(project.options).map(([name, id]) => ({ name, id })) },
      },
    },
    repository: { nameWithOwner: desktop },
  };
  const api = new GitHub('project-token', { fetcher: async (_url, { headers, body }) => {
    assert.equal(headers.Authorization, 'Bearer project-token');
    assert.doesNotMatch(JSON.parse(body).query, /\blogin\s+projectV2/);
    return response({ data: result });
  } });
  assert.deepEqual(await api.project(desktop), project);
  await assert.rejects(api.project(central), /Could not validate/);
  result.organization.projectV2.number = 2;
  await assert.rejects(api.project(desktop), /Could not validate/);
  result.organization.projectV2.number = 1;
  result.organization.projectV2.viewerCanUpdate = false;
  await assert.rejects(api.project(desktop), /cannot update project 1/);
  result.organization.projectV2.viewerCanUpdate = true;
  result.organization.projectV2.field.options.pop();
  await assert.rejects(api.project(desktop), /named Done/);
});

test('the REST assignment adds only NEVARLeVrai and does not replace existing assignees', async () => {
  const calls = [];
  const people = [{ login: 'existing' }];
  const api = new GitHub('project-token', { repo: desktop, repositoryToken: 'caller-token', fetcher: async (url, { method, body, headers }) => {
    assert.equal(headers.Authorization, 'Bearer caller-token');
    calls.push({ url, method, body });
    if (method === 'POST') people.push(...JSON.parse(body).assignees.map(login => ({ login })));
    return response({ assignees: people });
  } });
  const pr = item(1, { kind: 'PullRequest', repo: desktop });
  await api.assign(pr);
  await api.assign(pr);
  const url = `https://api.github.com/repos/${desktop}/issues/1`;
  assert.deepEqual(calls, [
    { url, method: 'GET', body: undefined },
    { url: `${url}/assignees`, method: 'POST', body: '{"assignees":["NEVARLeVrai"]}' },
    { url, method: 'GET', body: undefined },
  ]);
  assert.deepEqual(people.map(person => person.login), ['existing', 'NEVARLeVrai']);
});

test('only the caller token may close issues, and only in the caller repository', async () => {
  const requests = [];
  const api = new GitHub('project-token', { repo: desktop, repositoryToken: 'caller-token', fetcher: async (url, request) => {
    requests.push({ url, method: request.method, token: request.headers.Authorization, body: JSON.parse(request.body) });
    return response({ state: 'closed', state_reason: 'completed' });
  } });
  await assert.rejects(api.close(item(1)), /outside the caller/);
  await assert.rejects(api.assign(item(1)), /outside the caller/);
  await assert.rejects(api.close(item(2, { repo: desktop, kind: 'PullRequest' })), /Only issues/);
  await api.close(item(3, { repo: desktop }));
  assert.deepEqual(requests, [{
    url: `https://api.github.com/repos/${desktop}/issues/3`, method: 'PATCH',
    token: 'Bearer caller-token', body: { state: 'closed', state_reason: 'completed' },
  }]);
});
