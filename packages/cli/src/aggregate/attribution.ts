import { tickets } from "../cache/schema";
import type { TicketAttribution } from "./types";

// The configured mode picks one actor column per ticket, so opened, merged and
// closed all credit the same person and a collaborated ticket counts once.
// The login stays raw here and resolves through author_github_logins at query
// time; see docs/adr/0001.
export function creditedColumns(attribution: TicketAttribution) {
    return {
        assignee: { login: tickets.assignee, isBot: tickets.assigneeIsBot },
        author: { login: tickets.author, isBot: tickets.authorIsBot },
        closer: { login: tickets.closedBy, isBot: tickets.closedByIsBot },
    }[attribution];
}
