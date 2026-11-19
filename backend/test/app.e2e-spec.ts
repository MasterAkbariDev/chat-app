import { Test, TestingModule } from '@nestjs/testing'
import { INestApplication, VersioningType, VERSION_NEUTRAL } from '@nestjs/common'
import * as request from 'supertest'
import { App } from 'supertest/types'
import { MongoMemoryServer } from 'mongodb-memory-server'

describe('AppController (e2e)', () => {
  let app: INestApplication<App>
  let mongod: MongoMemoryServer

  beforeAll(async () => {
    // Generous timeout: boots an in-memory Mongo AND the full Nest app (every module,
    // including a Redis client construction for the throttler) once for the whole suite.
    mongod = await MongoMemoryServer.create({
      instance: { launchTimeout: 60_000 },
    })
    process.env.DATABASE_URL = mongod.getUri()
    process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379'
    process.env.CORS_ORIGIN = process.env.CORS_ORIGIN ?? 'http://localhost:3000'
    process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'test-secret'

    // Imported after env vars are set, since AppModule reads them at module-decoration time
    // (@WebSocketGateway's cors option) and at bootstrap.
    const { AppModule } = await import('./../src/app.module')
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile()

    app = moduleFixture.createNestApplication()
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: VERSION_NEUTRAL })
    await app.init()
  }, 90_000)

  afterAll(async () => {
    await app.close()
    await mongod.stop()
  }, 20_000)

  it('/ (GET) is public and returns 200 with no auth', async () => {
    const res = await request(app.getHttpServer()).get('/').expect(200)
    expect(res.body.message).toBe('Server is running.')
  })

  it('/auth/profile (GET-guarded route) rejects with no token', () => {
    return request(app.getHttpServer()).post('/auth/profile').expect(401)
  })

  it('/config-logs no longer exists', () => {
    return request(app.getHttpServer()).post('/config-logs').expect(404)
  })

  it('GET /v1/channels/mine rejects with no token (versioned route resolves)', () => {
    return request(app.getHttpServer()).get('/v1/channels/mine').expect(401)
  })

  it('GET /v1/channels/mine lists a chat created via the legacy /chats API, with an envelope shape', async () => {
    // bcrypt hashing on register + two more round trips — slower than the default 5s in this
    // sandboxed environment.
    const email = `channels-e2e-${Date.now()}@example.com`
    const register = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, username: `u${Date.now()}`, password: 'secret123' })
      .expect(201)
    const token: string = register.body.access_token
    expect(token).toEqual(expect.any(String))

    const createChat = await request(app.getHttpServer())
      .post('/chats/create')
      .set('Authorization', `Bearer ${token}`)
      .send({ link: `chan-${Date.now()}`, name: 'E2E Channel', type: 'group' })
      .expect(201)
    const channelId: string = createChat.body._id

    const list = await request(app.getHttpServer())
      .get('/v1/channels/mine')
      .set('Authorization', `Bearer ${token}`)
      .expect(200)

    expect(Array.isArray(list.body.items)).toBe(true)
    expect(list.body).toHaveProperty('nextCursor')
    expect(list.body.items.some((c: { channelId: string }) => c.channelId === channelId)).toBe(true)
  }, 20_000)
})
