import type { Part } from '@opencode-ai/sdk/v2';
import { readContextPart } from '@/lib/messages/contextParts';
import {
    GITHUB_ISSUE_CONTEXT_PREFIX,
    GITHUB_PR_CONTEXT_PREFIX,
    GITLAB_ISSUE_CONTEXT_PREFIX,
    GITLAB_MR_CONTEXT_PREFIX,
    GITEA_ISSUE_CONTEXT_PREFIX,
    GITEA_PR_CONTEXT_PREFIX,
    startsWithForgeContextPrefix,
} from '@/lib/messages/synthetic';


const LINEAR_ISSUE_CONTEXT_PREFIX = 'Linear issue context (JSON)';

type IssueContextPayload = {
    issue?: {
        number?: unknown;
        title?: unknown;
        url?: unknown;
    };
};

type GitHubPrContextPayload = {
    pr?: {
        number?: unknown;
        title?: unknown;
        url?: unknown;
    };
};

type LinearIssueContextPayload = {
    issue?: {
        identifier?: unknown;
        title?: unknown;
        url?: unknown;
    };
};

type GitLabMrContextPayload = {
    mr?: {
        number?: unknown;
        title?: unknown;
        url?: unknown;
    };
};

type GiteaPrContextPayload = {
    pr?: {
        number?: unknown;
        title?: unknown;
        url?: unknown;
    };
};

const isPositiveNumber = (value: unknown): value is number => {
    return typeof value === 'number' && Number.isFinite(value) && value > 0;
};

const parseSyntheticJsonPayload = <T>(text: string, prefix: string): T | null => {
    const normalizedText = text.trimStart();
    if (!normalizedText.startsWith(prefix)) {
        return null;
    }

    const jsonStart = normalizedText.indexOf('{');
    if (jsonStart < 0) {
        return null;
    }

    try {
        return JSON.parse(normalizedText.slice(jsonStart)) as T;
    } catch {
        return null;
    }
};

const buildForgeAttachmentPart = (text: string): Part | null => {
    // GitHub issues
    const ghIssuePayload = parseSyntheticJsonPayload<IssueContextPayload>(text, GITHUB_ISSUE_CONTEXT_PREFIX);
    if (ghIssuePayload) {
        const issue = ghIssuePayload.issue;
        const number = issue?.number;
        const title = issue?.title;
        const url = issue?.url;
        if (!isPositiveNumber(number) || typeof title !== 'string' || typeof url !== 'string') {
            return null;
        }
        return {
            type: 'file',
            mime: 'application/vnd.github.issue-link',
            filename: `Issue #${number}: ${title}`,
            url,
        } as Part;
    }

    // GitHub PRs
    const ghPrPayload = parseSyntheticJsonPayload<GitHubPrContextPayload>(text, GITHUB_PR_CONTEXT_PREFIX);
    if (ghPrPayload) {
        const pr = ghPrPayload.pr;
        const number = pr?.number;
        const title = pr?.title;
        const url = pr?.url;
        if (!isPositiveNumber(number) || typeof title !== 'string' || typeof url !== 'string') {
            return null;
        }
        return {
            type: 'file',
            mime: 'application/vnd.github.pull-request-link',
            filename: `PR #${number}: ${title}`,
            url,
        } as Part;
    }

    // Linear issues
    const linearPayload = parseSyntheticJsonPayload<LinearIssueContextPayload>(text, LINEAR_ISSUE_CONTEXT_PREFIX);
    if (linearPayload) {
        const issue = linearPayload.issue;
        const identifier = issue?.identifier;
        const title = issue?.title;
        const url = issue?.url;
        if (typeof identifier !== 'string' || identifier.trim().length === 0 || typeof title !== 'string' || typeof url !== 'string') {
            return null;
        }

        return {
            type: 'file',
            mime: 'application/vnd.openchamber.linear-issue-link',
            filename: `${identifier}: ${title}`,
            url,
        } as Part;
    }

    // GitLab issues
    const glIssuePayload = parseSyntheticJsonPayload<IssueContextPayload>(text, GITLAB_ISSUE_CONTEXT_PREFIX);
    if (glIssuePayload) {
        const issue = glIssuePayload.issue;
        const number = issue?.number;
        const title = issue?.title;
        const url = issue?.url;
        if (!isPositiveNumber(number) || typeof title !== 'string' || typeof url !== 'string') {
            return null;
        }
        return {
            type: 'file',
            mime: 'application/vnd.gitlab.issue-link',
            filename: `Issue #${number}: ${title}`,
            url,
        } as Part;
    }

    // GitLab MRs
    const glMrPayload = parseSyntheticJsonPayload<GitLabMrContextPayload>(text, GITLAB_MR_CONTEXT_PREFIX);
    if (glMrPayload) {
        const mr = glMrPayload.mr;
        const number = mr?.number;
        const title = mr?.title;
        const url = mr?.url;
        if (!isPositiveNumber(number) || typeof title !== 'string' || typeof url !== 'string') {
            return null;
        }
        return {
            type: 'file',
            mime: 'application/vnd.gitlab.merge-request-link',
            filename: `MR !${number}: ${title}`,
            url,
        } as Part;
    }

    // Gitea issues
    const gtIssuePayload = parseSyntheticJsonPayload<IssueContextPayload>(text, GITEA_ISSUE_CONTEXT_PREFIX);
    if (gtIssuePayload) {
        const issue = gtIssuePayload.issue;
        const number = issue?.number;
        const title = issue?.title;
        const url = issue?.url;
        if (!isPositiveNumber(number) || typeof title !== 'string' || typeof url !== 'string') {
            return null;
        }
        return {
            type: 'file',
            mime: 'application/vnd.gitea.issue-link',
            filename: `Issue #${number}: ${title}`,
            url,
        } as Part;
    }

    // Gitea PRs
    const gtPrPayload = parseSyntheticJsonPayload<GiteaPrContextPayload>(text, GITEA_PR_CONTEXT_PREFIX);
    if (gtPrPayload) {
        const pr = gtPrPayload.pr;
        const number = pr?.number;
        const title = pr?.title;
        const url = pr?.url;
        if (!isPositiveNumber(number) || typeof title !== 'string' || typeof url !== 'string') {
            return null;
        }
        return {
            type: 'file',
            mime: 'application/vnd.gitea.pull-request-link',
            filename: `PR #${number}: ${title}`,
            url,
        } as Part;
    }

    return null;
};

const shouldKeepSyntheticUserText = (text: string, planModeEnabled: boolean): boolean => {
    const trimmed = text.trim();
    if (planModeEnabled && trimmed.startsWith('User has requested to enter plan mode')) return true;
    if (planModeEnabled && trimmed.startsWith('The plan at ')) return true;
    if (trimmed.startsWith('The following tool was executed by the user')) return true;
    return false;
};

export const normalizeUserDisplayParts = (parts: Part[], options?: { planModeEnabled?: boolean }): Part[] => {
    const planModeEnabled = options?.planModeEnabled === true;
    return parts
        .filter((part) => {
            const synthetic = (part as { synthetic?: boolean }).synthetic === true;
            if (!synthetic) return true;
            if (part.type !== 'text') return false;
            if (readContextPart(part)) return true;
            const text = (part as { text?: unknown }).text;
            if (typeof text !== 'string') {
                return false;
            }

            const normalizedText = text.trimStart();
            return shouldKeepSyntheticUserText(text, planModeEnabled)
                || startsWithForgeContextPrefix(normalizedText)
                || normalizedText.startsWith(LINEAR_ISSUE_CONTEXT_PREFIX);
        })
        .map((part) => {
            const rawPart = part as Record<string, unknown>;
            if (rawPart.type === 'compaction') {
                return { type: 'text', text: '/compact' } as Part;
            }
            if (rawPart.type === 'text') {
                const text = typeof rawPart.text === 'string' ? rawPart.text.trim() : '';
                const synthetic = rawPart.synthetic === true;

                if (synthetic) {
                    const contextPayload = readContextPart(part);
                    if (contextPayload?.kind === 'github-issue' || contextPayload?.kind === 'github-pr' || contextPayload?.kind === 'linear-issue') {
                        // SAFETY: same display-only file-part shape the legacy
                        // buildGitHubAttachmentPart produces; consumed by
                        // FileAttachment, which matches on the mime type.
                        if (contextPayload.kind === 'linear-issue') {
                            return {
                                type: 'file',
                                mime: 'application/vnd.openchamber.linear-issue-link',
                                filename: `${contextPayload.identifier}: ${contextPayload.title}`,
                                url: contextPayload.url,
                            } as Part;
                        }
                        return {
                            type: 'file',
                            mime: contextPayload.kind === 'github-issue'
                                ? 'application/vnd.github.issue-link'
                                : 'application/vnd.github.pull-request-link',
                            filename: contextPayload.kind === 'github-issue'
                                ? `Issue #${contextPayload.number}: ${contextPayload.title}`
                                : `PR #${contextPayload.number}: ${contextPayload.title}`,
                            url: contextPayload.url,
                        } as Part;
                    }
                    if (contextPayload) {
                        // Other context kinds render through UserContextPart.
                        return part;
                    }
                    // Legacy messages: sniff the pre-metadata text format.
                    // buildForgeAttachmentPart covers GitHub, GitLab, and Gitea
                    // issue/PR/MR links (custom's multi-forge support).
                    const attachmentPart = buildForgeAttachmentPart(text);
                    if (attachmentPart) {
                        return attachmentPart;
                    }
                }

                if (text.startsWith('The following tool was executed by the user')) {
                    return { type: 'text', text: '/shell' } as Part;
                }
            }
            return part;
        });
};
