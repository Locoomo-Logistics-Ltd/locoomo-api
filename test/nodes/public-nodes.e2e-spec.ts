import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import { UserRole } from '../../src/common/auth/user-role.enum';
import { NODE_CONTACT_FIELDS } from '../fixtures/node-contact.fixture';

interface PublicNode {
  id: string;
  name: string;
  city: string;
  state: string;
  acceptingParcels: boolean;
  distanceKm: number | null;
  [key: string]: unknown;
}
interface Page {
  items: PublicNode[];
  nextCursor: string | null;
  hasMore: boolean;
}

// A made-up state keeps these Nodes apart from anything else in the DB.
const STATE = 'Pubnodes';
const PREFIX = 'public-nodes.e2e.test';

describe('Public Node directory (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  const ids: Record<string, string> = {};

  const http = (): ReturnType<typeof request> => request(app.getHttpServer());
  const list = async (query: string): Promise<Page> =>
    (
      (
        await http()
          .get(`/api/v1/public/nodes?state=${STATE}&${query}`)
          .expect(200)
      ).body as { data: Page }
    ).data;
  const names = (page: Page): string[] =>
    page.items.map((n) => n.name.replace(`${PREFIX} `, ''));

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();
    dataSource = moduleFixture.get(DataSource);
    const admin = `access_token=${moduleFixture
      .get(JwtService)
      .sign({ sub: 'admin-id', role: UserRole.ADMIN })}`;

    // name, city, km north of a fixed point
    const fixtures: [string, string, number][] = [
      ['Alpha Yaba', 'Yaba', 0],
      ['Bravo Ikeja', 'Ikeja', 4],
      ['Charlie Lekki', 'Lekki', 12],
      ['Delta Ajah', 'Ajah', 30],
      ['Echo Hidden', 'Yaba', 1],
    ];
    for (const [name, city, km] of fixtures) {
      const body = (
        await http()
          .post('/api/v1/nodes')
          .set('Cookie', [admin])
          .send({
            name: `${PREFIX} ${name}`,
            address: `${name} street`,
            city,
            state: STATE,
            latitude: 6.5 + km / 111,
            longitude: 3.38,
            capacity: 10,
            ...NODE_CONTACT_FIELDS,
          })
          .expect(201)
      ).body as { data: { id: string } };
      ids[name] = body.data.id;
    }
    // Bravo is full; Echo isn't listed publicly.
    await dataSource.query(
      `UPDATE nodes SET "currentCount" = capacity WHERE id = $1`,
      [ids['Bravo Ikeja']],
    );
    await dataSource.query(
      `UPDATE nodes SET "isPubliclyVisible" = false WHERE id = $1`,
      [ids['Echo Hidden']],
    );
  });

  afterAll(async () => {
    try {
      await dataSource.query(
        `DELETE FROM node_route_distances
          WHERE "originNodeId" IN (SELECT id FROM nodes WHERE name LIKE $1)
             OR "destinationNodeId" IN (SELECT id FROM nodes WHERE name LIKE $1)`,
        [`${PREFIX}%`],
      );
      await dataSource.query(`DELETE FROM nodes WHERE name LIKE $1`, [
        `${PREFIX}%`,
      ]);
    } finally {
      await app.close();
    }
  });

  it('lists listed Nodes without a session, by name, with public fields only', async () => {
    const response = await http()
      .get(`/api/v1/public/nodes?state=${STATE}`)
      .expect(200);
    expect(response.headers['cache-control']).toBe('public, max-age=60');
    const page = (response.body as { data: Page }).data;
    expect(names(page)).toEqual([
      'Alpha Yaba',
      'Bravo Ikeja',
      'Charlie Lekki',
      'Delta Ajah',
    ]);
    expect(Object.keys(page.items[0]).sort()).toEqual(
      [
        'acceptingParcels',
        'address',
        'city',
        'distanceKm',
        'id',
        'latitude',
        'longitude',
        'name',
        'openingHours',
        'state',
      ].sort(),
    );
    expect(
      page.items.find((n) => n.name.endsWith('Bravo Ikeja'))?.acceptingParcels,
    ).toBe(false);
  });

  it('searches and filters', async () => {
    expect(names(await list('q=lekki'))).toEqual(['Charlie Lekki']);
    expect(names(await list('q=street&city=yaba'))).toEqual(['Alpha Yaba']);
    expect(names(await list('acceptingParcels=true'))).not.toContain(
      'Bravo Ikeja',
    );
    expect(names(await list('acceptingParcels=false'))).toEqual([
      'Bravo Ikeja',
    ]);
    // `%` is a literal, not a wildcard.
    expect(names(await list('q=%25'))).toEqual([]);
  });

  it('orders by distance near a point, within the radius', async () => {
    const near = await list('near=6.5,3.38&radiusKm=20');
    expect(names(near)).toEqual(['Alpha Yaba', 'Bravo Ikeja', 'Charlie Lekki']);
    expect(near.items[0].distanceKm).toBe(0);
    expect(near.items[2].distanceKm).toBeGreaterThan(11);
    expect(names(await list('near=6.5,3.38&radiusKm=20&order=desc'))).toEqual([
      'Charlie Lekki',
      'Bravo Ikeja',
      'Alpha Yaba',
    ]);
    // Another order with `near` still limits to the radius.
    expect(names(await list('near=6.5,3.38&radiusKm=20&sort=city'))).toEqual([
      'Bravo Ikeja',
      'Charlie Lekki',
      'Alpha Yaba',
    ]);
  });

  it('orders by city or name, either way', async () => {
    expect(names(await list('sort=city'))).toEqual([
      'Delta Ajah',
      'Bravo Ikeja',
      'Charlie Lekki',
      'Alpha Yaba',
    ]);
    expect(names(await list('sort=name&order=desc'))).toEqual([
      'Delta Ajah',
      'Charlie Lekki',
      'Bravo Ikeja',
      'Alpha Yaba',
    ]);
  });

  it('pages with a cursor', async () => {
    const first = await list('limit=3');
    expect(first.hasMore).toBe(true);
    const second = await list(
      `limit=3&cursor=${encodeURIComponent(first.nextCursor!)}`,
    );
    expect(second).toMatchObject({ hasMore: false, nextCursor: null });
    expect([...names(first), ...names(second)]).toHaveLength(4);
  });

  it('rejects bad queries', async () => {
    await http().get('/api/v1/public/nodes?sort=distance').expect(400);
    await http().get('/api/v1/public/nodes?sort=capacity').expect(400);
    await http().get('/api/v1/public/nodes?near=lagos').expect(400);
    await http().get('/api/v1/public/nodes?limit=101').expect(400);
  });

  it('shows one Node, and hides unlisted ones', async () => {
    const one = (
      (
        await http()
          .get(`/api/v1/public/nodes/${ids['Alpha Yaba']}`)
          .expect(200)
      ).body as { data: PublicNode }
    ).data;
    expect(one).toMatchObject({
      name: `${PREFIX} Alpha Yaba`,
      acceptingParcels: true,
    });
    expect(one).not.toHaveProperty('contactPhone');
    await http().get(`/api/v1/public/nodes/${ids['Echo Hidden']}`).expect(404);
  });

  it('lists states and cities for the filters', async () => {
    const locations = (
      (await http().get('/api/v1/public/nodes/locations').expect(200)).body as {
        data: {
          state: string;
          count: number;
          cities: { city: string; count: number }[];
        }[];
      }
    ).data;
    expect(locations.find((l) => l.state === STATE)).toEqual({
      state: STATE,
      count: 4,
      cities: [
        { city: 'Ajah', count: 1 },
        { city: 'Ikeja', count: 1 },
        { city: 'Lekki', count: 1 },
        { city: 'Yaba', count: 1 },
      ],
    });
  });
});
