# Image-Matching Feature Design

## Overview

The image-matching system enables clients to upload a photo (e.g., their current hair/nails/skin) and receive ranked recommendations of service providers whose portfolio work matches what they want. This leverages the existing AI tagging infrastructure (`tagPortfolioMedia`) and search pipeline to provide visual discovery.

---

## Architecture Layers

```
┌─────────────────────────────────────────────────────────────┐
│ CLIENT                                                      │
│ - Upload photo + optional keyword                           │
│ - Receive ranked providers/services/packages                │
└────────────┬────────────────────────────────────────────────┘
             │
┌────────────▼────────────────────────────────────────────────┐
│ IMAGE MATCHING CONTROLLER                                   │
│ - Route: POST /api/v1/app/image-match                       │
│ - Validates input, calls imageMatchService                  │
│ - Returns ranked results with match metadata                │
└────────────┬────────────────────────────────────────────────┘
             │
┌────────────▼────────────────────────────────────────────────┐
│ IMAGE MATCH SERVICE (New)                                   │
│ ├─ Analyze client photo → extract tags/terms                │
│ ├─ Query portfolio index (pre-indexed photos)               │
│ ├─ Score matches (visual + text + metadata)                 │
│ └─ Rank and return top N results with scores                │
└────────────┬────────────────────────────────────────────────┘
             │
      ┌──────┴──────┬──────────────┬──────────────┐
      │             │              │              │
      ▼             ▼              ▼              ▼
  ┌────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐
  │ Image  │  │ AI       │  │ Portfolio│  │ Distance │
  │Analysis│  │ Providers│  │ Index    │  │ Scoring  │
  │(Existing)│  │(Existing)│  │(Cache)   │  │          │
  └────────┘  └──────────┘  └──────────┘  └──────────┘
       │            │             │             │
       └────────────┼─────────────┴─────────────┘
                    │
         ┌──────────▼──────────┐
         │ MongoDB Collections │
         │ - Portfolio (w/tags)│
         │ - BusinessProfile   │
         │ - Services          │
         │ - Packages          │
         └─────────────────────┘
```

---

## 1. Client Photo Analysis

### Input
```
POST /api/v1/app/image-match
{
  "file": <multipart file>,        // OR
  "imageUrl": "s3://...",          // existing portfolio image
  "keyword": "hair color change",  // optional text context
  "lat": 37.7749,
  "lng": -122.4194,
  "maxDistance": 15,               // km, optional
  "limit": 20
}
```

### Processing
1. **Resolve image source** (reuse `resolveImageSource` from `imageInput.js`)
   - Upload buffer → convert to data URL via sharp
   - OR fetch existing S3 URL
   - Validate it's a real image

2. **Analyze image** (reuse `analyzeImage` from `imageAnalysis.js`)
   - Call `tagPortfolioImage()` → vision model returns JSON
   - Extract `{ description, technique[], style[], color[] }`
   - Apply `MAX_TERMS` limit (keep top 14 unique terms)
   - Cache result by image content hash (30-day Redis TTL)

3. **Expand query** (reuse `resolveNaturalSearch`)
   - If keyword provided, expand it via `expandPortfolioSearchQuery()`
   - Merge keyword expansions with image tags
   - Run stemming + flexible pattern matching
   - Extract day/time availability filters if keyword contains them

### Output
```js
{
  clientImage: {
    description: "Medium-length blonde hair with soft waves",
    technique: ["balayage", "wave set"],
    style: ["beachy waves", "medium length"],
    color: ["blonde", "honey"],
  },
  expandedTerms: ["balayage", "wave", "medium", ...],     // after stemming
  regexes: [/balayage/i, /wav/i, ...],                     // for matching
  availability: { dayOfWeek, startTime, endTime, ... },   // extracted from keyword
  hasText: true
}
```

---

## 2. Portfolio Photo Indexing

### Strategy: Lazy + Async Backfill

**On portfolio creation/update:**
- When a photo is uploaded → `tagPortfolioImage()` runs (already does this)
- Stores tags in `Portfolio.media[].ai_tags`
- Stores aggregated `Portfolio.search_keywords` (flattened, deduped terms from all photos)
- Both happen synchronously on the write but failures degrade gracefully (no tags ≠ broken save)

**Index structure in MongoDB:**
```js
Portfolio {
  _id: ObjectId,
  business: ObjectId,                    // BusinessProfile
  name: String,                          // portfolio name
  description: String,
  media: [
    {
      file: "s3-key",
      thumbnail: "s3-key-thumb",
      ai_tags: {
        description: "...",
        technique: ["balayage", "highlights", ...],
        style: ["long", "layered", ...],
        color: ["copper", "rose gold", ...],
      }
    }
  ],
  search_keywords: [                     // flattened, deduped from all media
    "balayage", "highlight", "copper", "long", "layer", ...
  ],
  createdAt: Date,
  updatedAt: Date
}
```

**Cache layer (optional, for scoring speed):**
- Redis hash: `portfolio:index:{businessId}`
  - Keys: `{portfolioId}:tags`
  - Values: JSON of `{ technique[], style[], color[], description }`
  - TTL: 7 days (invalidate on portfolio write)
  - Fallback: query MongoDB if cache miss

---

## 3. Matching & Scoring

### Three-tier scoring system

```
                    ┌─────────────────────────────────┐
                    │  CLIENT IMAGE ANALYSIS          │
                    │  - technique: [balayage, ombre] │
                    │  - style: [waves, long]         │
                    │  - color: [copper]              │
                    └────────────┬────────────────────┘
                                 │
                     ┌───────────┴────────────┐
                     │                        │
        ┌────────────▼────────────┐  ┌───────▼──────────────┐
        │ VECTOR SIMILARITY SCORE │  │ TEXT REGEX MATCH     │
        │ (Semantic)              │  │ (Keyword matching)   │
        │                         │  │                      │
        │ Each portfolio photo:   │  │ Count regex hits:    │
        │ 1. Encode tags as      │  │ - Each match = +1    │
        │    embeddings          │  │ - Normalize by       │
        │ 2. Compare to client   │  │   total terms        │
        │ 3. Cosine similarity   │  │                      │
        │ 4. → score 0.0-1.0     │  │ → score 0.0-1.0      │
        └────────────┬───────────┘  └───────┬──────────────┘
                     │                      │
        ┌────────────▼────────────────────┬─▼──────────────┐
        │                                 │                │
        │        COMPOSITE SCORE          │                │
        │                                 │                │
        │  scoreVector × 0.5 +            │                │
        │  scoreText × 0.3 +              │                │
        │  scoreMetadata × 0.2            │                │
        │  = finalScore (0.0-1.0)         │                │
        │                                 │                │
        │  Metadata factors:              │                │
        │  - Business availability        │                │
        │  - Service/package availability │                │
        │  - Distance decay               │                │
        │  - Business rating (if exists)  │                │
        └───────────┬─────────────────────┘                │
                    │                                      │
                    └──────────────────────────────────────┘
                                 │
                    ┌────────────▼────────────────────┐
                    │  RANKING & FILTERING             │
                    │  1. Filter by score threshold    │
                    │  2. Sort by composite score DESC │
                    │  3. Apply distance ceiling       │
                    │  4. Paginate (limit)             │
                    │  5. Enrich with portfolio cards  │
                    │     + match reasoning            │
                    └─────────────────────────────────┘
```

### Detailed Scoring Methods

#### 3A. Vector Similarity (Semantic) — 50% weight

**Embedding strategy:**
- Pre-compute embeddings for all portfolio tags at index time
- Use `generateEmbeddings()` from AI provider (Claude/OpenAI API)
- Cache embeddings in Redis: `embeddings:{hash(tags)}`
- Recompute only when tags change

**Comparison:**
- Embed client image terms → `clientVec`
- For each portfolio photo, embed its tags → `portfolioVec`
- Cosine similarity: `similarity = (clientVec · portfolioVec) / (||clientVec|| × ||portfolioVec||)`
- Take max similarity across all photos in a portfolio
- Normalize to 0.0-1.0

```js
// Pseudo-code
const clientTags = ["balayage", "copper", "waves"];
const clientVec = await embedTags(clientTags);  // cached

const portfolioScore = Math.max(
  ...portfolio.media.map(photo => {
    const photoVec = await embedTags(photo.ai_tags.technique, photo.ai_tags.color);
    return cosineSimilarity(clientVec, photoVec);
  })
);
// portfolioScore: 0.0-1.0
```

#### 3B. Text Regex Matching (Keyword) — 30% weight

**Matching:**
- Portfolio already has `search_keywords[]` (aggregated from all media tags)
- Run client's regex patterns against `portfolio.search_keywords`
- Count matches

```js
const matchCount = regexes.filter(regex => 
  search_keywords.some(kw => regex.test(kw))
).length;

const textScore = matchCount / Math.max(regexes.length, 1);
// textScore: 0.0-1.0
```

**Example:**
- Client regexes: `/balay/i`, `/wav/i`, `/copper/i`, `/long/i`
- Portfolio keywords: `["balayage", "highlight", "copper", "medium"]`
- Matches: `balayage` ✓, `copper` ✓ → 2/4 = 0.5

#### 3C. Metadata Scoring (Context) — 20% weight

**Factors:**
- Business availability: `business.isAvailable === true` → +0.5
- Not suspended: `!business.suspendedUntil || suspendedUntil < now` → +0.2
- Service/package active: `service.status === "active"` → +0.2
- Distance decay: smooth falloff as distance increases
  ```js
  const distanceScore = Math.max(0, 1 - (distanceKm / maxDistanceKm) * 0.3);
  ```
- Business rating (optional, if present): `(avgRating / 5) * 0.1`

```js
const metadataScore = 
  (businessAvailable ? 0.5 : 0) +
  (!suspended ? 0.2 : 0) +
  (serviceActive ? 0.2 : 0) +
  distanceDecay * 0.1;
  
const normalizedMetadata = Math.min(metadataScore, 1.0);
```

### Composite Scoring

```js
const finalScore = 
  vectorScore * 0.5 +      // semantic match
  textScore * 0.3 +        // keyword coverage
  metadataScore * 0.2;     // context/availability
```

**Confidence interpretation:**
- `0.80–1.0` → Excellent match (top-tier recommendation)
- `0.60–0.79` → Good match (secondary tier)
- `0.40–0.59` → Possible match (further down list)
- `0.00–0.39` → Weak match (filtered out in most queries)

---

## 4. Ranking & Result Assembly

### Database Query Pattern

```js
// 1. Fetch all relevant portfolios + embedded business/service data
const portfolios = await Portfolio.aggregate([
  {
    $match: {
      "search_keywords": { $in: relevantTerms }  // text index match
    }
  },
  {
    $lookup: {
      from: "businessprofiles",
      localField: "business",
      foreignField: "_id",
      as: "businessData"
    }
  },
  {
    $unwind: "$businessData"
  },
  {
    $geoNear: {
      near: { type: "Point", coordinates: [lng, lat] },
      distanceField: "distanceKm",
      maxDistance: maxDistanceKm * 1000,
      spherical: true
    }
  },
  { $limit: 1000 }  // fetch many, score in-app
]);

// 2. Score each portfolio in-app
const scored = await Promise.all(portfolios.map(async (portfolio) => {
  const vectors = await Promise.all(
    portfolio.media.map(photo => embedTags(photo.ai_tags))
  );
  
  const vectorScore = Math.max(...vectors.map(v => 
    cosineSimilarity(clientVec, v)
  ));
  
  const textScore = matchCount / regexes.length;
  const metadataScore = computeMetadata(portfolio);
  
  return {
    ...portfolio,
    scores: { vectorScore, textScore, metadataScore },
    finalScore: vectorScore * 0.5 + textScore * 0.3 + metadataScore * 0.2,
    matchReason: buildMatchExplanation(vectorScore, textScore)
  };
}));

// 3. Sort, filter, paginate
const ranked = scored
  .filter(p => p.finalScore >= THRESHOLD)
  .sort((a, b) => b.finalScore - a.finalScore)
  .slice(0, limit);
```

### Response Format

```js
{
  success: true,
  data: {
    clientImage: {
      description: "...",
      technique: [...],
      style: [...],
      color: [...]
    },
    matches: [
      {
        portfolio: {
          _id, name, description,
          media: [{ file, thumbnail, ai_tags }]
        },
        business: {
          _id, name, slug, location,
          isAvailable, rating, reviewCount
        },
        services: [{ _id, name, price, duration }],
        packages: [{ _id, name, price, duration }],
        distanceKm: 2.5,
        
        // Match scoring & reasoning
        scores: {
          vectorScore: 0.87,     // semantic match
          textScore: 0.75,       // keyword coverage
          metadataScore: 0.80    // availability/distance
        },
        finalScore: 0.818,
        
        // Human-readable explanation
        matchReason: {
          primary: "Balayage + copper highlights match your photo",
          secondary: "5km away, available now",
          confidence: "high"
        }
      },
      // ... more ranked results
    ]
  },
  meta: {
    total: 47,                    // total matches before pagination
    returned: 20,
    scoreThreshold: 0.4,
    queryTimeMs: 1240
  }
}
```

---

## 5. Implementation Roadmap

### Phase 1: MVP (Weeks 1-2)
- [ ] Create `imageMatchService.js` with scoring logic
- [ ] Add controller + route: `POST /api/v1/app/image-match`
- [ ] Simple vector scoring (using existing embeddings or string similarity)
- [ ] Text regex matching
- [ ] Basic metadata scoring
- [ ] Query existing portfolios by search_keywords
- [ ] Test with Postman

### Phase 2: Performance (Weeks 3-4)
- [ ] Add Redis cache for portfolio embeddings
- [ ] Batch embedding computation (lazy index backfill)
- [ ] MongoDB text index optimization
- [ ] Implement scoring cache (avoid recomputing for same client image)
- [ ] Load test with 1000+ portfolios

### Phase 3: Polish (Week 5)
- [ ] Add match reasoning/explanations
- [ ] A/B test scoring weights (0.5/0.3/0.2)
- [ ] Personalize based on user preferences
- [ ] Track clicks/bookings to improve ranking
- [ ] Swagger docs
- [ ] Error recovery (AI failures, missing tags)

### Phase 4: Advanced (Future)
- [ ] Real-time vector search (Pinecone, Weaviate)
- [ ] Multi-modal search (image + voice description)
- [ ] Learn weights from user behavior
- [ ] Provider clustering (style/technique specialty)
- [ ] Duplicate photo detection (same result shown twice)

---

## 6. Data Structures

### New Service: `imageMatchService.js`

```js
module.exports = {
  // Main entry point
  matchProvidersByImage({ imageUrl, keyword, lat, lng, maxDistance, limit }),
  
  // Scoring helpers (internal)
  scorePortfolioVector(clientVec, portfolio),
  scorePortfolioText(regexes, portfolio),
  scorePortfolioMetadata(portfolio, lat, lng, maxDistance),
  
  // Embedding helpers
  embedTags(tags),                  // → vector
  getEmbeddingsFromCache(hash),     // → vector | null
  cacheEmbeddings(hash, vector),
};
```

### New Model: `PortfolioIndex` (optional, for large-scale)

```js
// Only if we need dedicated index storage beyond Portfolio.search_keywords
{
  portfolio: ObjectId,
  business: ObjectId,
  tags: { technique[], style[], color[] },
  keywords: [String],
  embeddings: [Number],           // vector
  lastIndexedAt: Date,
}
```

---

## 7. Error Handling & Degradation

| Failure | Behavior |
|---------|----------|
| Image analysis fails (bad image) | Return 400 with `image_invalid` |
| No terms extracted (blank image) | Return empty results instead of error |
| AI tagging unavailable | Still search by keyword if provided; degrade to text-only |
| Embedding API quota exceeded | Use text regex matching only (60% score cap) |
| Distance calculation fails | Ignore distance in scoring |
| Portfolio has no tags (old data) | Still match via text keywords |

---

## 8. Example User Flow

```
User: Uploads photo of "dark purple nails with long coffin shape"
      Keyword: "dark purple nails"

1. Analyze Photo
   → Description: "Long coffin-shaped nails with dark purple color"
   → Technique: ["nail extension", "coffin shape"]
   → Style: ["long", "coffin nails"]
   → Color: ["dark purple", "plum"]

2. Expand Keyword
   → "dark" + "purple" + "nails" + "long" + "coffin"
   → Stem: ["dark", "purpl", "nail", "long", "coffin"]
   → Add flexibility: "/coffin?nails?/", etc.

3. Query Portfolios
   → Find portfolios with search_keywords matching any term
   → Fetch 100 candidates (geo-nearby, available)

4. Score Each Portfolio
   Vector: Does this provider do similar style/color?
   Text: Do their portfolio terms match the keywords?
   Meta: Are they close, available, well-reviewed?

5. Rank & Return Top 20
   Portfolio A: finalScore 0.92 → "Perfect match, same technique, close by"
   Portfolio B: finalScore 0.84 → "Great style match, 8km away"
   Portfolio C: finalScore 0.71 → "Similar vibe, different color"
   ...

6. User clicks → Browse provider portfolio, book service
```

---

## 9. Testing Strategy

**Unit tests:**
- Scoring math (vector, text, metadata)
- Embedding caching
- Term expansion

**Integration tests:**
- End-to-end image upload → ranked results
- Verify scores are deterministic
- Test with mock portfolios

**Load tests:**
- 1000 portfolios × 10 concurrent requests
- Measure scoring latency per request
- Verify cache hit rates

**Manual tests (Postman):**
```
POST /api/v1/app/image-match
{
  "file": <hair photo>,
  "keyword": "balayage copper",
  "lat": 37.7749,
  "lng": -122.4194,
  "limit": 10
}

Expect: Ranked list with scores, reasons, provider details
```

---

## 10. Configuration & Tuning

### Environment Variables

```bash
# Scoring weights (0.0-1.0, should sum to 1.0)
IMAGE_MATCH_VECTOR_WEIGHT=0.5
IMAGE_MATCH_TEXT_WEIGHT=0.3
IMAGE_MATCH_METADATA_WEIGHT=0.2

# Filtering
IMAGE_MATCH_SCORE_THRESHOLD=0.4
IMAGE_MATCH_DEFAULT_LIMIT=20
IMAGE_MATCH_MAX_LIMIT=100

# Distance
IMAGE_MATCH_DEFAULT_MAX_KM=20
IMAGE_MATCH_DISTANCE_DECAY_FACTOR=0.3

# Caching
IMAGE_MATCH_EMBEDDING_CACHE_TTL=604800  # 7 days
IMAGE_MATCH_SCORE_CACHE_TTL=3600        # 1 hour (per client image)
```

### Tuning Heuristics

- **High false positives** (bad matches ranked high) → increase `VECTOR_WEIGHT`, decrease `TEXT_WEIGHT`
- **Too few results** → lower `SCORE_THRESHOLD` or increase `MAX_LIMIT`
- **Distance too prominent** → lower `DISTANCE_DECAY_FACTOR`
- **Slow queries** → increase `SCORE_CACHE_TTL`, enable embedding cache

---

## 11. API Specification

### Endpoint

```
POST /api/v1/app/image-match
Content-Type: multipart/form-data

Params:
- file (optional): uploaded image (multipart)
- imageUrl (optional): existing S3 image URL
- keyword (optional): text query to combine with image
- lat (optional): caller's latitude
- lng (optional): caller's longitude
- maxDistance (optional): km radius, default 20
- limit (optional): number of results, default 20, max 100

Returns:
{
  success: boolean,
  data: {
    clientImage: { description, technique, style, color },
    matches: [
      {
        portfolio: { _id, name, description, media },
        business: { _id, name, slug, location, isAvailable, rating },
        services: [...],
        packages: [...],
        distanceKm: number,
        scores: { vectorScore, textScore, metadataScore },
        finalScore: number,
        matchReason: { primary, secondary, confidence }
      }
    ]
  },
  meta: { total, returned, scoreThreshold, queryTimeMs }
}
```

---

## 12. Future Enhancements

- **User preferences** → weight scores based on stated style/skill
- **Provider feedback** → track which matches led to bookings
- **Style profiles** → group providers by specialty (balayage expert, extensions specialist)
- **Seasonal trends** → rank recent portfolio work higher
- **Duplicate detection** → merge similar-looking results
- **A/B testing** → experiment with scoring weights
- **Mobile app integration** → native camera capture → real-time preview
- **AR preview** → overlay matched styles on user's photo

---

## Summary

The image-matching feature builds on your existing AI tagging + search infrastructure to provide visual discovery:

1. **Input:** Client uploads photo + optional keyword
2. **Analysis:** Vision model extracts technique/style/color tags
3. **Index:** Reuse `Portfolio.media[].ai_tags` (already computed on write)
4. **Scoring:** Three-tier system (vectors 50%, text 30%, metadata 20%)
5. **Output:** Ranked provider list with match reasoning

**Key principles:**
- Reuse existing AI pipeline (no new providers needed)
- Cache aggressively (embeddings, scoring, results)
- Degrade gracefully (AI failures never break the feature)
- Keep latency < 500ms for 100-portfolio queries
- Explain why matches rank (confidence, reasons)

