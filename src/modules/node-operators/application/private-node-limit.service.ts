import {
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, In } from 'typeorm';
import { AdminPermission } from '../../../common/auth/admin-permission.enum';
import { shouldRunBackgroundJobs } from '../../../common/process/background-jobs';
import type { Env } from '../../../config/env.validation';
import { AdminPermissionService } from '../../identity/application/admin-permission.service';
import { UserLookupService } from '../../identity/application/user-lookup.service';
import { NodesService } from '../../nodes/application/nodes.service';
import { renderEmail } from '../../notifications/application/email-template';
import { OutboxService } from '../../notifications/application/outbox.service';
import { NodeMembershipRole } from '../domain/node-membership-role.enum';
import { NodeMembershipStatus } from '../domain/node-membership-status.enum';
import { NodeMembershipEntity } from '../infrastructure/entities/node-membership.entity';

const INTERVAL_NAME = 'private-node-limit';
const INTERVAL_MS = 60 * 60 * 1000;

// Private Nodes serve only their owner's own dispatches, up to
// PRIVATE_NODE_MONTHLY_ORDER_LIMIT orders a Lagos month. Past that the
// orders still go through, and ops are emailed (once a month per Node) to
// review converting it to public (PATCH /nodes/:id isPubliclyVisible).
@Injectable()
export class PrivateNodeLimitService
  implements OnModuleInit, OnApplicationShutdown
{
  private readonly logger = new Logger(PrivateNodeLimitService.name);
  private running = false;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly nodes: NodesService,
    private readonly adminPermissions: AdminPermissionService,
    private readonly userLookup: UserLookupService,
    private readonly outbox: OutboxService,
    private readonly scheduler: SchedulerRegistry,
    private readonly config: ConfigService<Env, true>,
  ) {}

  get limit(): number {
    return this.config.get('PRIVATE_NODE_MONTHLY_ORDER_LIMIT', { infer: true });
  }

  onModuleInit(): void {
    if (shouldRunBackgroundJobs(this.config)) {
      this.scheduler.addInterval(
        INTERVAL_NAME,
        setInterval(() => void this.tick(), INTERVAL_MS),
      );
    }
  }

  onApplicationShutdown(): void {
    if (this.scheduler.doesExist('interval', INTERVAL_NAME)) {
      this.scheduler.deleteInterval(INTERVAL_NAME);
    }
  }

  private async tick(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      const alerted = await this.run();
      if (alerted.length > 0) {
        this.logger.warn(
          `Private Nodes over the monthly limit: ${alerted.join(', ')}`,
        );
      }
    } catch (error) {
      this.logger.error('Private Node limit check failed', error as Error);
    } finally {
      this.running = false;
    }
  }

  // Emails ops about each private Node newly over the limit this month.
  // Returns the Node ids alerted.
  async run(): Promise<string[]> {
    const over = await this.nodes.privateNodesOverLimit(this.limit);
    if (over.length === 0) {
      return [];
    }
    const ops = (await this.adminPermissions.list()).filter(
      (admin) =>
        String(admin.status) === 'active' &&
        (admin.adminPermissions.includes(AdminPermission.OPS) ||
          admin.adminPermissions.includes(AdminPermission.SUPER)),
    );
    if (ops.length === 0) {
      // Not marked as alerted: the next run tries again once ops exist.
      this.logger.error(
        'Private Nodes over the monthly limit, but no active admin has the ops permission',
      );
      return [];
    }
    const owners = await this.owners(over.map((node) => node.nodeId));
    const alerted: string[] = [];
    for (const node of over) {
      const owner = owners.get(node.nodeId);
      await this.dataSource.transaction(async (manager) => {
        for (const admin of ops) {
          const { html, text } = renderEmail({
            greetingName: admin.firstName,
            heading: 'A private Node is over its monthly limit',
            blocks: [
              {
                kind: 'details',
                rows: [
                  { label: 'Node', value: node.name },
                  { label: 'Node ID', value: node.nodeId },
                  { label: 'Location', value: `${node.city}, ${node.state}` },
                  {
                    label: 'Owner',
                    value: owner
                      ? `${owner.name} (${owner.email})`
                      : 'No active owner',
                  },
                  {
                    label: `Orders in ${node.month}`,
                    value: `${node.orders} (limit ${this.limit})`,
                  },
                ],
              },
              {
                kind: 'paragraph',
                text: 'Private Nodes serve only their owner’s own parcels. Orders still go through, but at this volume it should become a public Node: agree it with the owner, then set it public (Admin › Nodes › this Node › Public). You’ll hear about this Node again next month if it stays private and over the limit.',
              },
            ],
          });
          await this.outbox.enqueueEmail(
            {
              to: admin.email,
              subject: `Private Node over its monthly limit: ${node.name}`,
              text,
              html,
            },
            manager,
          );
        }
        await this.nodes.markPrivateLimitAlerted(
          node.nodeId,
          node.month,
          manager,
        );
      });
      alerted.push(node.nodeId);
    }
    return alerted;
  }

  private async owners(
    nodeIds: string[],
  ): Promise<Map<string, { name: string; email: string }>> {
    const memberships = await this.dataSource.manager.find(
      NodeMembershipEntity,
      {
        where: {
          nodeId: In(nodeIds),
          roleAtNode: NodeMembershipRole.OWNER,
          status: NodeMembershipStatus.ACTIVE,
        },
      },
    );
    const contacts = new Map(
      (await this.userLookup.getContacts(memberships.map((m) => m.userId))).map(
        (contact) => [contact.id, contact],
      ),
    );
    const byNode = new Map<string, { name: string; email: string }>();
    for (const membership of memberships) {
      const contact = contacts.get(membership.userId);
      if (contact && !byNode.has(membership.nodeId)) {
        byNode.set(membership.nodeId, {
          name: `${contact.firstName} ${contact.lastName}`.trim(),
          email: contact.email,
        });
      }
    }
    return byNode;
  }
}
