import { createServer } from 'node:http'

// A stand-in for the GitHub API: the plan comment and the commit identity are the only API calls the action makes,
// and a test must not make them for real. It answers the routes GitHub answers, and refuses the ones an App
// installation token cannot use, so a wrong route fails a test instead of passing quietly.
export async function startApiStub({ login = 'docs-publisher[bot]', id = 12345, comments = [] } = {}) {
  const calls = []
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => (body += chunk))
    request.on('end', () => {
      const url = request.url.split('?')[0]
      calls.push({ method: request.method, url, body: body === '' ? undefined : JSON.parse(body) })
      const json = (status, payload) => {
        response.statusCode = status
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify(payload))
      }
      // `GET /user` reads the authenticated user's own account. GitHub refuses it for an App installation token:
      // an installation acts as `<slug>[bot]`, which only GraphQL's viewer names.
      if (request.method === 'GET' && url === '/user') {
        return json(403, { message: 'Resource not accessible by integration' })
      }
      if (request.method === 'POST' && url === '/graphql') {
        return json(200, { data: { viewer: { login } } })
      }
      const user = /^\/users\/([^/]+)$/.exec(url)
      if (request.method === 'GET' && user && decodeURIComponent(user[1]) === login) return json(200, { login, id })
      // The plan comment: one issue comment, listed, created and replaced through the issue's own route.
      if (request.method === 'GET' && /^\/repos\/[^/]+\/[^/]+\/issues\/\d+\/comments$/.test(url)) {
        return json(200, comments)
      }
      if (request.method === 'POST' && /^\/repos\/[^/]+\/[^/]+\/issues\/\d+\/comments$/.test(url)) {
        return json(201, { id: 4242 })
      }
      if (request.method === 'PATCH' && /^\/repos\/[^/]+\/[^/]+\/issues\/comments\/\d+$/.test(url)) {
        return json(200, { id: 4242 })
      }
      json(404, { message: `no stub route for ${request.method} ${url}` })
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    comments,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}
