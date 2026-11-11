<?php
/**
 * Сервер голосования «Личное дело».
 *
 * Один файл, без базы данных: голоса лежат в JSON-хранилище с блокировкой.
 * После каждого изменения публикуется статичный api/state.json — его опрашивают
 * телефоны зрителей и табло, поэтому PHP нагружается только голосами и пультом.
 *
 * Запросы: api/index.php?a=state|vote|login|session|control|reset
 * Требования: PHP 7.4+ (расширения по умолчанию, mbstring не нужен).
 */

declare(strict_types=1);

const TOKEN_TTL = 12 * 3600;          // сколько живёт вход в пульт
const LOGIN_WINDOW = 15 * 60;         // окно подсчёта неудачных попыток
const LOGIN_MAX_FAILS = 8;            // попыток на окно с одного адреса
const MAX_VOTERS = 20000;             // защита хранилища от раздувания
const SUGGESTION_MAX = 180;

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store, max-age=0');
header('X-Content-Type-Options: nosniff');

$config = loadConfig();
handleCors($config);

try {
    $action = isset($_GET['a']) ? (string)$_GET['a'] : 'state';
    $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

    switch ($action) {
        case 'state':
            respond(200, publicState(readStore()));
        case 'vote':
            requireMethod($method, 'POST');
            respond(200, ['ok' => true, 'state' => vote(readJsonBody())]);
        case 'login':
            requireMethod($method, 'POST');
            login($config, readJsonBody());
        case 'session':
            requireAdmin();
            respond(200, ['ok' => true]);
        case 'control':
            requireMethod($method, 'POST');
            requireAdmin();
            respond(200, ['ok' => true, 'state' => control(readJsonBody())]);
        case 'reset':
            requireMethod($method, 'POST');
            requireAdmin();
            respond(200, ['ok' => true, 'state' => resetVotes()]);
        default:
            respond(404, ['error' => 'unknown_action']);
    }
} catch (HttpError $e) {
    respond($e->status, ['error' => $e->getMessage()]);
} catch (Throwable $e) {
    error_log('lichnoe-delo api: ' . $e->getMessage());
    respond(500, ['error' => 'server_error']);
}

// ---------------------------------------------------------------- действия

function vote(array $body): array
{
    $voterId = isset($body['voterId']) ? (string)$body['voterId'] : '';
    if (!preg_match('/^[A-Za-z0-9._-]{8,80}$/', $voterId)) {
        throw new HttpError(400, 'bad_voter');
    }
    $choice = isset($body['choice']) ? (string)$body['choice'] : '';
    if (!in_array($choice, ['psychology', 'numerology', 'custom'], true)) {
        throw new HttpError(400, 'bad_choice');
    }
    $suggestion = '';
    if ($choice === 'custom' && isset($body['suggestion'])) {
        $suggestion = cleanText((string)$body['suggestion'], SUGGESTION_MAX);
    }

    return mutate(function (array &$store) use ($voterId, $choice, $suggestion) {
        if (!isset($store['votes'][$voterId]) && count($store['votes']) >= MAX_VOTERS) {
            throw new HttpError(429, 'too_many_voters');
        }
        $store['votes'][$voterId] = ['c' => $choice, 's' => $suggestion, 't' => time()];
        // Живой голос возвращает стрелку к реальным цифрам.
        $store['control']['gaugeOverride'] = null;
        // «Нули» ведущих — заставка перед стартом: первый голос её снимает.
        $display = $store['control']['display'];
        if (is_array($display) && array_sum(array_map('intval', $display)) === 0) {
            $store['control']['display'] = null;
        }
    });
}

function control(array $patch): array
{
    return mutate(function (array &$store) use ($patch) {
        if (array_key_exists('display', $patch)) {
            $d = $patch['display'];
            if ($d === null) {
                $store['control']['display'] = null;
            } elseif (is_array($d)) {
                $store['control']['display'] = [
                    'psychology' => clampInt($d['psychology'] ?? 0, 0, 100000),
                    'numerology' => clampInt($d['numerology'] ?? 0, 0, 100000),
                    'abstain' => clampInt($d['abstain'] ?? 0, 0, 100000),
                ];
            } else {
                throw new HttpError(400, 'bad_display');
            }
        }
        if (array_key_exists('gaugeOverride', $patch)) {
            $g = $patch['gaugeOverride'];
            $store['control']['gaugeOverride'] = $g === null ? null : clampInt($g, 0, 100);
        }
        if (array_key_exists('expectedVotes', $patch)) {
            $store['control']['expectedVotes'] = clampInt($patch['expectedVotes'], 1, 10000);
        }
    });
}

function resetVotes(): array
{
    return mutate(function (array &$store) {
        $store['votes'] = [];
        $store['control']['display'] = null;
        $store['control']['gaugeOverride'] = null;
    });
}

function login(array $config, array $body): void
{
    $pin = (string)($config['admin_pin'] ?? '');
    if ($pin === '') {
        throw new HttpError(503, 'admin_not_configured');
    }
    $ipKey = substr(hash('sha256', clientIp()), 0, 16);
    $now = time();

    // Проверка лимита попыток и запись результата — под одной блокировкой.
    $token = null;
    $limited = false;
    mutate(function (array &$store) use ($pin, $body, $ipKey, $now, &$token, &$limited) {
        foreach ($store['fails'] as $key => $times) {
            $store['fails'][$key] = array_values(array_filter($times, function ($t) use ($now) {
                return $t > $now - LOGIN_WINDOW;
            }));
            if (!$store['fails'][$key]) {
                unset($store['fails'][$key]);
            }
        }
        if (count($store['fails'][$ipKey] ?? []) >= LOGIN_MAX_FAILS) {
            $limited = true;
            return;
        }
        $given = isset($body['pin']) ? (string)$body['pin'] : '';
        if (hash_equals($pin, $given)) {
            unset($store['fails'][$ipKey]);
            $token = makeToken($store['secret'], $now + TOKEN_TTL);
        } else {
            $store['fails'][$ipKey][] = $now;
        }
    }, false);

    if ($limited) {
        throw new HttpError(429, 'too_many_attempts');
    }
    if ($token === null) {
        throw new HttpError(401, 'wrong_pin');
    }
    respond(200, ['token' => $token, 'expiresIn' => TOKEN_TTL]);
}

function requireAdmin(): void
{
    $token = '';
    foreach (['HTTP_X_ADMIN_TOKEN', 'HTTP_AUTHORIZATION', 'REDIRECT_HTTP_AUTHORIZATION'] as $key) {
        if (!empty($_SERVER[$key])) {
            $token = (string)$_SERVER[$key];
            break;
        }
    }
    if ($token === '' && function_exists('getallheaders')) {
        foreach (getallheaders() as $name => $value) {
            if (strcasecmp($name, 'Authorization') === 0) {
                $token = (string)$value;
            }
        }
    }
    $token = trim(preg_replace('/^Bearer\s+/i', '', $token));
    if (!checkToken(readStore()['secret'], $token)) {
        throw new HttpError(401, 'unauthorized');
    }
}

// ---------------------------------------------------------------- хранилище

function dataDir(): string
{
    static $dir = null;
    if ($dir !== null) {
        return $dir;
    }
    $config = loadConfig();
    $candidates = [];
    if (!empty($config['data_dir'])) {
        $candidates[] = rtrim((string)$config['data_dir'], '/\\');
    }
    // По умолчанию — за пределами папки сайта, чтобы файлы нельзя было скачать.
    $candidates[] = dirname(__DIR__, 2) . DIRECTORY_SEPARATOR . 'lichnoe-delo-data';
    $candidates[] = __DIR__ . DIRECTORY_SEPARATOR . 'data';
    foreach ($candidates as $candidate) {
        if (is_dir($candidate) || @mkdir($candidate, 0750, true)) {
            if (is_writable($candidate)) {
                return $dir = $candidate;
            }
        }
    }
    throw new RuntimeException('no writable data dir');
}

/** Хранилище — PHP-файл с exit в первой строке: даже из папки сайта его не прочитать. */
function storePath(): string
{
    return dataDir() . DIRECTORY_SEPARATOR . 'store.php';
}

function emptyStore(): array
{
    return [
        'secret' => bin2hex(random_bytes(32)),
        'rev' => 0,
        'votes' => [],
        'control' => ['display' => null, 'gaugeOverride' => null, 'expectedVotes' => 50],
        'fails' => [],
    ];
}

function readStore(): array
{
    $path = storePath();
    if (!is_file($path)) {
        // Первый запуск: создаём хранилище (секрет для входа ведущих) и state.json.
        return mutate(function () {
        }, false, true);
    }
    $raw = (string)file_get_contents($path);
    return decodeStore($raw);
}

function decodeStore(string $raw): array
{
    $json = substr($raw, (int)strpos($raw, "\n") + 1);
    $store = json_decode($json, true);
    if (!is_array($store) || empty($store['secret'])) {
        throw new RuntimeException('store corrupted');
    }
    $store['votes'] = (array)($store['votes'] ?? []);
    $store['fails'] = (array)($store['fails'] ?? []);
    $store['control'] = array_merge(emptyStore()['control'], (array)($store['control'] ?? []));
    return $store;
}

/**
 * Изменить хранилище под эксклюзивной блокировкой.
 * Возвращает публичное состояние (или всё хранилище при $returnStore).
 */
function mutate(callable $fn, bool $publish = true, bool $returnStore = false): array
{
    $path = storePath();
    $lock = fopen($path . '.lock', 'c');
    if (!$lock || !flock($lock, LOCK_EX)) {
        throw new RuntimeException('cannot lock store');
    }
    try {
        $store = is_file($path) ? decodeStore((string)file_get_contents($path)) : emptyStore();
        $isNew = !is_file($path);
        $fn($store);
        $store['rev'] = (int)$store['rev'] + 1;
        $payload = "<?php exit; ?>\n" . json_encode($store, JSON_UNESCAPED_UNICODE);
        writeAtomic($path, $payload);
        $state = publicState($store);
        if ($publish || $isNew) {
            publishState($state);
        }
        return $returnStore ? $store : $state;
    } finally {
        flock($lock, LOCK_UN);
        fclose($lock);
    }
}

/**
 * Статичная копия состояния для опроса. Голос к этому моменту уже сохранён,
 * поэтому сбой публикации не должен превращаться в ошибку для зрителя:
 * убираем устаревший файл — клиенты сами перейдут на api/index.php?a=state.
 */
function publishState(array $state): void
{
    $path = __DIR__ . DIRECTORY_SEPARATOR . 'state.json';
    try {
        writeAtomic($path, json_encode($state, JSON_UNESCAPED_UNICODE));
    } catch (Throwable $e) {
        error_log('lichnoe-delo api: ' . $e->getMessage());
        @unlink($path);
    }
}

function writeAtomic(string $path, string $content): void
{
    $tmp = $path . '.' . bin2hex(random_bytes(4)) . '.tmp';
    if (file_put_contents($tmp, $content) === false) {
        throw new RuntimeException('cannot write ' . basename($path));
    }
    @chmod($tmp, 0644);
    if (!@rename($tmp, $path)) {
        // Windows не перезаписывает файл через rename — удаляем и пробуем снова.
        @unlink($path);
        if (!rename($tmp, $path)) {
            @unlink($tmp);
            throw new RuntimeException('cannot replace ' . basename($path));
        }
    }
}

function publicState(array $store): array
{
    $counts = ['psychology' => 0, 'numerology' => 0, 'custom' => 0];
    $suggestions = [];
    $votes = $store['votes'];
    uasort($votes, function ($a, $b) {
        return ($a['t'] ?? 0) <=> ($b['t'] ?? 0);
    });
    foreach ($votes as $vote) {
        $choice = $vote['c'] ?? '';
        if (isset($counts[$choice])) {
            $counts[$choice]++;
        }
        if ($choice === 'custom' && ($vote['s'] ?? '') !== '') {
            $suggestions[] = $vote['s'];
        }
    }
    return [
        'votes' => $counts,
        'suggestions' => $suggestions,
        'control' => $store['control'],
        'rev' => (int)$store['rev'],
        'updatedAt' => time(),
    ];
}

// ---------------------------------------------------------------- служебное

final class HttpError extends Exception
{
    public $status;

    public function __construct(int $status, string $code)
    {
        parent::__construct($code);
        $this->status = $status;
    }
}

function loadConfig(): array
{
    static $config = null;
    if ($config === null) {
        $file = __DIR__ . '/config.php';
        $config = is_file($file) ? (array)(require $file) : [];
    }
    return $config;
}

function handleCors(array $config): void
{
    $origin = $_SERVER['HTTP_ORIGIN'] ?? '';
    $allowed = (array)($config['allowed_origins'] ?? []);
    if ($origin !== '' && in_array($origin, $allowed, true)) {
        header('Access-Control-Allow-Origin: ' . $origin);
        header('Vary: Origin');
        header('Access-Control-Allow-Headers: Content-Type, Authorization, X-Admin-Token');
        header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
    }
    if (($_SERVER['REQUEST_METHOD'] ?? '') === 'OPTIONS') {
        http_response_code(204);
        exit;
    }
}

function requireMethod(string $method, string $expected): void
{
    if ($method !== $expected) {
        throw new HttpError(405, 'method_not_allowed');
    }
}

function readJsonBody(): array
{
    $raw = (string)file_get_contents('php://input', false, null, 0, 16384);
    $data = json_decode($raw, true);
    if (!is_array($data)) {
        throw new HttpError(400, 'bad_json');
    }
    return $data;
}

function cleanText(string $text, int $max): string
{
    $text = preg_replace('/[\x00-\x1F\x7F]+/u', ' ', $text) ?? '';
    $text = trim(preg_replace('/\s+/u', ' ', $text) ?? '');
    if (preg_match('/^.{0,' . $max . '}/us', $text, $m)) {
        $text = $m[0];
    }
    return $text;
}

function clampInt($value, int $min, int $max): int
{
    if (!is_numeric($value)) {
        throw new HttpError(400, 'bad_number');
    }
    return max($min, min($max, (int)round((float)$value)));
}

function clientIp(): string
{
    return (string)($_SERVER['REMOTE_ADDR'] ?? '0.0.0.0');
}

function makeToken(string $secret, int $expires): string
{
    return $expires . '.' . hash_hmac('sha256', 'admin|' . $expires, $secret);
}

function checkToken(string $secret, string $token): bool
{
    if (!preg_match('/^(\d{9,12})\.([a-f0-9]{64})$/', $token, $m)) {
        return false;
    }
    if ((int)$m[1] < time()) {
        return false;
    }
    return hash_equals(hash_hmac('sha256', 'admin|' . $m[1], $secret), $m[2]);
}

function respond(int $status, array $body): void
{
    http_response_code($status);
    echo json_encode($body, JSON_UNESCAPED_UNICODE);
    exit;
}
