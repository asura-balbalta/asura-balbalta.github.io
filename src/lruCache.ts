/**
 * 개수 상한 LRU 캐시(캐시 통일 리팩토링 C1, 2026-10-23. docs/cache-refactor-plan.md 3.1). 모든 캐시가 이것 하나를 쓰고 캐시마다 다른 것은
 * 상한과 키뿐이다. 메인·조정자·보조 워커가 같이 import 하므로 의존성 없이 둔다.
 *
 * - 순서는 Map 의 넣은 순서: 적중(get·getOrLoad)은 지웠다 다시 넣어 맨 뒤(최근)로 옮기고, 개수가 max 를 넘으면 맨 앞(가장 오래 안 쓴 것)부터 하나씩 비운다
 * - 값이 Promise 면 끝났을 때 bytesOf 로 바이트를 잰다(통계용. 지우는 기준은 개수). 그때 이미 밀려났거나 다른 값으로 바뀐 항목이면 세지 않아
 *   바이트는 지금 들고 있는 항목의 합이다
 * - 받는 중인 항목이 밀려나도 기다리는 쪽은 Promise 를 쥐고 있어 결과를 받는다. 다음 요청은 다시 받는다
 * - Promise 가 실패하면 그 키의 항목이 아직 그 Promise 일 때만 지운다(그 사이 새로 넣은 값은 둔다)
 * - 적중·놓침·밀려난 수는 만든 뒤 누계다(clear 해도 남는다)
 */
export type LruStats = { count: number; bytes: number; max: number; hits: number; misses: number; evictions: number }

export type LruCache<K, V> = {
    /** 있으면 최근으로 옮겨 돌려준다. 적중·놓침을 센다 */
    get: (key: K) => V | undefined
    /** 넣는다(같은 키는 바꾼다). 넘치면 오래된 것부터 비운다 */
    set: (key: K, value: V) => void
    /** 있으면 get 과 같고, 없으면 load() 의 값을 넣고 돌려준다(Promise 면 같은 키의 요청이 그 Promise 를 같이 기다린다) */
    getOrLoad: (key: K, load: () => V) => V
    delete: (key: K) => boolean
    clear: () => void
    /** 상한을 바꾼다(줄이면 바로 비운다) */
    setMax: (max: number) => void
    stats: () => LruStats
}

const isThenable = (v: unknown): v is PromiseLike<unknown> => typeof (v as { then?: unknown } | null)?.then === "function"

/**
 * @param opts.max 개수 상한(1 이상)
 * @param opts.bytesOf 값 하나의 바이트(통계용. Promise 는 끝난 값으로 부른다). 없거나, 던지거나, 유한하지 않은 값이면 그 항목은 0
 */
export const createLruCache = <K, V>(opts: { max: number; bytesOf?: (value: Awaited<V>) => number }): LruCache<K, V> => {
    let max = opts.max
    const map = new Map<K, { value: V; bytes: number }>()
    let bytes = 0, hits = 0, misses = 0, evictions = 0
    let warned = false
    /** bytesOf 가 던지거나 유한하지 않은 값을 내면 0 으로 센다(통계 때문에 Promise 사슬이 거부되지 않게. 경고는 캐시마다 한 번) */
    const sizeOf = (v: Awaited<V>) => {
        try {
            const b = opts.bytesOf!(v)
            if (Number.isFinite(b)) return b
        } catch (err) {
            if (!warned) console.warn("LruCache: bytesOf 실패, 0 바이트로 셈", err)
            warned = true
        }
        return 0
    }

    const remove = (key: K) => {
        const e = map.get(key)
        if (!e) return false
        map.delete(key)
        bytes -= e.bytes
        return true
    }
    const trim = () => {
        while (map.size > max) {
            remove(map.keys().next().value as K)
            evictions++
        }
    }
    const lookup = (key: K) => {
        const e = map.get(key)
        if (!e) {
            misses++
            return undefined
        }
        hits++
        map.delete(key)
        map.set(key, e)
        return e
    }
    const put = (key: K, value: V) => {
        remove(key)
        const e = { value, bytes: 0 }
        map.set(key, e)
        const measure = (v: Awaited<V>) => {
            if (map.get(key) !== e || !opts.bytesOf) return
            e.bytes = sizeOf(v)
            bytes += e.bytes
        }
        if (isThenable(value)) value.then((v) => measure(v as Awaited<V>), () => map.get(key) === e && remove(key))
        else measure(value as Awaited<V>)
        trim()
    }

    return {
        get: (key) => lookup(key)?.value,
        set: put,
        getOrLoad: (key, load) => {
            const hit = lookup(key)
            if (hit) return hit.value
            const value = load()
            put(key, value)
            return value
        },
        delete: remove,
        clear: () => {
            map.clear()
            bytes = 0
        },
        setMax: (n) => {
            max = n
            trim()
        },
        stats: () => ({ count: map.size, bytes, max, hits, misses, evictions }),
    }
}

/** 고정 칸이 있는 캐시의 통계: 합계(고정 + LRU) 개수·바이트·적중, max·놓침·밀려남은 LRU 쪽. pinned·pinnedBytes 는 고정 칸 */
export type PinnedStats = LruStats & { pinned: number; pinnedBytes: number }

/**
 * 고정 칸 + LRU(캐시 통일 D6 (b), 2026-10-23 결정 by @nanangqq). 고정 칸(상한 없음)에는 지금 선택의 도엽을, LruCache(max)에는 선택 밖 도엽(둘러보기
 * 스트리밍)을 둔다. 큰 선택의 표현 방식 전환이 상한을 순서대로 훑어 모두 밀려나던 것(C6: 340도엽 둘러보기 진입 적중 343 → 5)을 막는다.
 * 찾기는 고정 칸 → LRU, 넣기는 pin 에 따라 한쪽(같은 키는 한 곳에만 두고 다른 쪽에서 지운다). 값은 동기 값만(결과 층·자른 TIN)
 */
export const createPinnedLruCache = <K, V>(opts: { max: number; bytesOf?: (value: V) => number }) => {
    const lru = createLruCache<K, V>({ max: opts.max, bytesOf: opts.bytesOf as ((value: Awaited<V>) => number) | undefined })
    const pinned = new Map<K, { value: V; bytes: number }>()
    let pinnedBytes = 0
    let pinnedHits = 0
    const sizeOf = (v: V) => {
        const b = opts.bytesOf?.(v) ?? 0
        return Number.isFinite(b) ? b : 0
    }
    const unpin = (key: K) => {
        const e = pinned.get(key)
        if (!e) return false
        pinned.delete(key)
        pinnedBytes -= e.bytes
        return true
    }
    return {
        get: (key: K): V | undefined => {
            const e = pinned.get(key)
            if (e) {
                pinnedHits++
                return e.value
            }
            return lru.get(key)
        },
        /** pin 이면 고정 칸에(상한 없음), 아니면 LRU 에 */
        set: (key: K, value: V, pin: boolean) => {
            if (pin) {
                lru.delete(key)
                unpin(key)
                const bytes = sizeOf(value)
                pinned.set(key, { value, bytes })
                pinnedBytes += bytes
            } else {
                unpin(key)
                lru.set(key, value)
            }
        },
        delete: (key: K) => {
            const a = unpin(key)
            const b = lru.delete(key)
            return a || b
        },
        clear: () => {
            pinned.clear()
            pinnedBytes = 0
            lru.clear()
        },
        stats: (): PinnedStats => {
            const s = lru.stats()
            return { ...s, count: s.count + pinned.size, bytes: s.bytes + pinnedBytes, hits: s.hits + pinnedHits, pinned: pinned.size, pinnedBytes }
        },
    }
}
