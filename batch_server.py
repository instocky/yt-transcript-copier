import argparse
import json
import threading
import time
import uuid
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

HOST = '127.0.0.1'
PORT = 8765
LEASE_TTL_SECONDS = 120
MAX_ATTEMPTS = 3
EXECUTION_TIMEOUT_SECONDS = 120
BACKOFF_SECONDS = {
    2: 5,
    3: 30,
}
MARKDOWN_PREVIEW_WORDS = 30
INTER_JOB_DELAY_SECONDS = 7


def now_ts() -> float:
    return time.time()


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class BatchState:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.batches: dict[str, dict[str, Any]] = {}
        self.jobs: dict[str, dict[str, Any]] = {}
        self.order: list[str] = []

    def create_batch(self, urls: list[str], batch_id: str | None = None) -> str:
        batch_id = batch_id or f"batch-{datetime.now().strftime('%Y%m%d-%H%M%S')}"

        with self.lock:
            self.batches[batch_id] = {
                'batch_id': batch_id,
                'created_at': now_iso(),
                'job_ids': [],
            }

            for index, url in enumerate(urls, start=1):
                job_id = f"job-{index:04d}-{uuid.uuid4().hex[:6]}"
                job = {
                    'batch_id': batch_id,
                    'job_id': job_id,
                    'url': url,
                    'status': 'queued',
                    'attempt': 0,
                    'lease_expires_at': None,
                    'next_eligible_at': now_ts(),
                    'started_at': None,
                    'finished_at': None,
                    'duration_ms': None,
                    'filename': None,
                    'result': None,
                    'error': None,
                    'max_attempts': MAX_ATTEMPTS,
                }
                self.jobs[job_id] = job
                self.order.append(job_id)
                self.batches[batch_id]['job_ids'].append(job_id)

        return batch_id

    def health(self) -> dict[str, Any]:
        with self.lock:
            self._reclaim_expired_leases_locked()
            counts = {'queued': 0, 'in_progress': 0, 'done': 0, 'error': 0}
            for job in self.jobs.values():
                counts[job['status']] = counts.get(job['status'], 0) + 1
            return {
                'ok': True,
                'queued': counts['queued'],
                'in_progress': counts['in_progress'],
                'done': counts['done'],
                'error': counts['error'],
            }

    def next_job(self) -> dict[str, Any] | None:
        with self.lock:
            self._reclaim_expired_leases_locked()
            current_time = now_ts()

            for job_id in self.order:
                job = self.jobs[job_id]
                if job['status'] != 'queued':
                    continue
                if job['next_eligible_at'] > current_time:
                    continue
                if job['attempt'] >= job['max_attempts']:
                    continue

                job['status'] = 'in_progress'
                job['attempt'] += 1
                job['lease_expires_at'] = current_time + LEASE_TTL_SECONDS
                job['started_at'] = now_iso()
                job['finished_at'] = None
                job['duration_ms'] = None
                job['error'] = None

                return {
                    'batch_id': job['batch_id'],
                    'job_id': job['job_id'],
                    'url': job['url'],
                    'attempt': job['attempt'],
                    'lease_ttl': LEASE_TTL_SECONDS,
                    'execution_timeout': EXECUTION_TIMEOUT_SECONDS,
                    'inter_job_delay_ms': INTER_JOB_DELAY_SECONDS * 1000,
                }

        return None

    def report(self, payload: dict[str, Any]) -> dict[str, Any]:
        required = {'batch_id', 'job_id', 'attempt', 'status', 'url'}
        missing = required.difference(payload)
        if missing:
            raise ValueError(f"Missing fields: {', '.join(sorted(missing))}")

        with self.lock:
            self._reclaim_expired_leases_locked()
            job = self.jobs.get(payload['job_id'])
            if not job:
                raise KeyError('Unknown job_id')

            attempt = int(payload['attempt'])
            if attempt < job['attempt']:
                return {'ok': True, 'ignored': True, 'reason': 'stale_attempt'}

            status = payload['status']
            if status == 'in_progress':
                job['status'] = 'in_progress'
                job['lease_expires_at'] = now_ts() + LEASE_TTL_SECONDS
                job['started_at'] = payload.get('started_at') or job['started_at'] or now_iso()
                return {'ok': True, 'ignored': False}

            if status == 'done':
                job['status'] = 'done'
                job['lease_expires_at'] = None
                job['finished_at'] = payload.get('finished_at') or now_iso()
                job['duration_ms'] = payload.get('duration_ms')
                job['filename'] = payload.get('filename')
                job['result'] = payload.get('result')
                job['error'] = None
                return {'ok': True, 'ignored': False}

            if status == 'error':
                error = payload.get('error') or {}
                retryable = bool(error.get('retryable'))

                if retryable and attempt < job['max_attempts']:
                    next_attempt = attempt + 1
                    delay = BACKOFF_SECONDS.get(next_attempt, 30)
                    job['status'] = 'queued'
                    job['lease_expires_at'] = None
                    job['next_eligible_at'] = now_ts() + delay
                    job['finished_at'] = payload.get('finished_at') or now_iso()
                    job['duration_ms'] = payload.get('duration_ms')
                    job['error'] = error
                    return {
                        'ok': True,
                        'ignored': False,
                        'requeued': True,
                        'next_attempt': next_attempt,
                        'backoff_seconds': delay,
                    }

                job['status'] = 'error'
                job['lease_expires_at'] = None
                job['finished_at'] = payload.get('finished_at') or now_iso()
                job['duration_ms'] = payload.get('duration_ms')
                job['filename'] = payload.get('filename')
                job['result'] = payload.get('result')
                job['error'] = error
                return {'ok': True, 'ignored': False, 'requeued': False}

            raise ValueError(f"Unsupported status: {status}")

    def batch_complete(self, batch_id: str) -> bool:
        with self.lock:
            job_ids = self.batches[batch_id]['job_ids']
            return all(self.jobs[job_id]['status'] in {'done', 'error'} for job_id in job_ids)

    def summary(self, batch_id: str) -> dict[str, Any]:
        with self.lock:
            jobs = [self.jobs[job_id] for job_id in self.batches[batch_id]['job_ids']]
            return {
                'batch_id': batch_id,
                'total': len(jobs),
                'done': sum(1 for job in jobs if job['status'] == 'done'),
                'error': sum(1 for job in jobs if job['status'] == 'error'),
                'jobs': [build_summary_job(job) for job in jobs],
            }

    def _reclaim_expired_leases_locked(self) -> None:
        current_time = now_ts()
        for job in self.jobs.values():
            if job['status'] != 'in_progress':
                continue
            if not job['lease_expires_at'] or job['lease_expires_at'] > current_time:
                continue

            if job['attempt'] >= job['max_attempts']:
                job['status'] = 'error'
                job['finished_at'] = now_iso()
                job['error'] = {
                    'type': 'TIMEOUT',
                    'message': 'Lease expired and max attempts reached',
                    'retryable': False,
                }
                job['lease_expires_at'] = None
                continue

            next_attempt = job['attempt'] + 1
            delay = BACKOFF_SECONDS.get(next_attempt, 30)
            job['status'] = 'queued'
            job['lease_expires_at'] = None
            job['next_eligible_at'] = current_time + delay
            job['error'] = {
                'type': 'TIMEOUT',
                'message': 'Lease expired before completion',
                'retryable': True,
            }


STATE = BatchState()


class RequestHandler(BaseHTTPRequestHandler):
    server_version = 'YTTranscriptBatchServer/0.1'

    def do_GET(self) -> None:
        if self.path == '/health':
            self._send_json(HTTPStatus.OK, STATE.health())
            return

        if self.path.startswith('/next'):
            job = STATE.next_job()
            if job is None:
                self.send_response(HTTPStatus.NO_CONTENT)
                self.end_headers()
                return
            self._send_json(HTTPStatus.OK, job)
            return

        self._send_json(HTTPStatus.NOT_FOUND, {'error': 'Not found'})

    def do_POST(self) -> None:
        try:
            payload = self._read_json()
        except ValueError as error:
            self._send_json(HTTPStatus.BAD_REQUEST, {'error': str(error)})
            return

        if self.path == '/jobs':
            urls = payload.get('urls') or []
            if not isinstance(urls, list) or not urls:
                self._send_json(HTTPStatus.BAD_REQUEST, {'error': 'Field urls must be a non-empty list'})
                return
            batch_id = STATE.create_batch(urls, payload.get('batch_id'))
            self._send_json(HTTPStatus.CREATED, {'batch_id': batch_id, 'count': len(urls)})
            return

        if self.path == '/report':
            try:
                result = STATE.report(payload)
            except (KeyError, ValueError) as error:
                self._send_json(HTTPStatus.BAD_REQUEST, {'error': str(error)})
                return
            self._send_json(HTTPStatus.OK, result)
            return

        self._send_json(HTTPStatus.NOT_FOUND, {'error': 'Not found'})

    def log_message(self, format: str, *args: Any) -> None:
        return

    def _read_json(self) -> dict[str, Any]:
        length = int(self.headers.get('Content-Length', '0'))
        raw = self.rfile.read(length) if length else b'{}'
        try:
            return json.loads(raw.decode('utf-8'))
        except json.JSONDecodeError as error:
            raise ValueError(f'Invalid JSON: {error}') from error

    def _send_json(self, status: HTTPStatus, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def load_urls(path: Path) -> list[str]:
    urls = []
    for line in path.read_text(encoding='utf-8').splitlines():
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        urls.append(line)
    return urls


def build_summary_job(job: dict[str, Any]) -> dict[str, Any]:
    summary_job = dict(job)
    result = summary_job.get('result')
    if isinstance(result, dict):
        summary_job['result'] = {
            **result,
            'markdown': truncate_words(result.get('markdown'), MARKDOWN_PREVIEW_WORDS),
        }
    return summary_job


def truncate_words(value: Any, limit: int) -> Any:
    if not isinstance(value, str):
        return value

    words = value.split()
    if len(words) <= limit:
        return value

    return ' '.join(words[:limit]) + ' ...'


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description='Short-lived localhost server for YT transcript batch export')
    parser.add_argument('input', type=Path, help='Path to text file with one YouTube URL per line')
    parser.add_argument('--batch-id', dest='batch_id', default=None, help='Optional batch id')
    parser.add_argument('--host', default=HOST, help='Bind host, default 127.0.0.1')
    parser.add_argument('--port', type=int, default=PORT, help='Bind port, default 8765')
    return parser


def main() -> int:
    parser = build_arg_parser()
    args = parser.parse_args()

    urls = load_urls(args.input)
    if not urls:
        parser.error('Input file does not contain any URLs')

    batch_id = STATE.create_batch(urls, args.batch_id)
    server = ThreadingHTTPServer((args.host, args.port), RequestHandler)

    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    print(f'Batch server started on http://{args.host}:{args.port}')
    print(f'batch_id={batch_id} jobs={len(urls)}')
    print('Waiting for the Chrome extension to poll /next ...')

    try:
        while not STATE.batch_complete(batch_id):
            time.sleep(1)
    except KeyboardInterrupt:
        print('Interrupted by user')
        return 130
    finally:
        server.shutdown()
        server.server_close()

    summary = STATE.summary(batch_id)
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0 if summary['error'] == 0 else 1


if __name__ == '__main__':
    raise SystemExit(main())
