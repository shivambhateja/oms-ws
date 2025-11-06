/**
 * Publisher browsing functions - Calls external API and returns data
 */

export interface BrowsePublishersArgs {
  // Basic filters
  niche?: string;
  language?: string;
  country?: string;
  searchQuery?: string;  // Maps to 'website' in API
  
  // Authority metrics
  daMin?: number;  // Domain Authority min
  daMax?: number;  // Domain Authority max
  paMin?: number;  // Page Authority min
  paMax?: number;  // Page Authority max
  drMin?: number;  // Domain Rating min
  drMax?: number;  // Domain Rating max
  
  // Spam & Quality
  spamMin?: number;
  spamMax?: number;
  
  // Traffic metrics
  semrushOverallTrafficMin?: number;
  semrushOrganicTrafficMin?: number;
  
  // Pricing
  priceMin?: number;
  priceMax?: number;
  
  // Backlink attributes
  backlinkNature?: "do-follow" | "no-follow";
  linkPlacement?: string;
  permanence?: "lifetime" | "12-months";
  
  // Availability & Status
  availability?: boolean;
  
  // Text search filters
  remarkIncludes?: string;
  
  // Pagination
  page?: number;
  limit?: number;
}

export interface PublisherData {
  id: string;
  website: string;
  websiteName: string;
  rating: number;
  doFollow: boolean;
  niche: string[];
  type: "Premium" | "Standard";
  country: string;
  language: string;
  authority: {
    dr: number;
    da: number;
    as: number;
  };
  spam: {
    percentage: number;
    level: "Low" | "Medium" | "High";
  };
  pricing: {
    base: number;
    withContent: number;
  };
  trend: "Stable" | "Rising" | "Falling";
  outboundLinks: number;
}

export interface BrowsePublishersResult {
  publishers: PublisherData[];
  totalCount: number;
  filters: BrowsePublishersArgs;
  // Summary for AI context (small)
  summary: string;
}

function transformPublisherData(item: any): PublisherData {
  // Transform external API data to our structure
  const spamScore = item.spamScore || 0;
  const spamLevel = spamScore < 5 ? 'Low' : spamScore < 15 ? 'Medium' : 'High';
  
  return {
    id: item.id || item.website,
    website: item.website,
    websiteName: item.websiteName || item.website,
    rating: item.rating || 4,
    doFollow: item.doFollow !== undefined ? item.doFollow : true,
    niche: Array.isArray(item.niche) ? item.niche : [item.niche || 'General'],
    type: item.type || 'Standard',
    country: item.country || 'Unknown',
    language: item.language || 'English',
    authority: {
      dr: item.domainRating || item.dr || 0,
      da: item.domainAuthority || item.da || 0,
      as: item.authorityScore || item.as || 0,
    },
    spam: {
      percentage: spamScore,
      level: spamLevel,
    },
    pricing: {
      base: item.sellingPrice || item.price || item.pricing?.base || 0,
      withContent: item.withContentPrice || item.pricing?.withContent || (item.sellingPrice || item.price || 0) * 1.5,
    },
    trend: item.trend || 'Stable',
    outboundLinks: item.outboundLinks || item.obl || 0,
  };
}

export async function browsePublishers(args: BrowsePublishersArgs): Promise<BrowsePublishersResult> {
  // Add artificial delay for testing (4 seconds)
  await new Promise(resolve => setTimeout(resolve, 4000));
  
  // Fetching publishers

  let publishers: PublisherData[] = [];
  let usedFallback = false;

  // Try to fetch from external API
  if (process.env.OUTREACH_API_URL) {
    try {
      
      // Build API filters following Mosaic format
      const apiFilters = buildAPIFilters(args);
      const filterQuery = buildFilterQuery(apiFilters);
      
      const requestBody: any = {};
      if (filterQuery) {
        requestBody.filters = filterQuery;
      }
      if (args.limit) requestBody.limit = args.limit;
      if (args.page) {
        requestBody.page = args.page;
        requestBody.offset = (args.page - 1) * (args.limit || 8);
      }
      
      // Request body built
      
      const response = await fetch(process.env.OUTREACH_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: Object.keys(requestBody).length > 0 ? JSON.stringify(requestBody) : undefined,
        signal: AbortSignal.timeout(10000), // 10 second timeout
      });

      if (!response.ok) {
        throw new Error(`API responded with status: ${response.status}`);
      }

      const data = await response.json() as any;
      const rawPublishers = data.sites || data.publishers || data; // Handle different response formats
      
      // Transform API data to match our structure
      publishers = rawPublishers.map((item: any) => transformPublisherData(item));
      
    } catch (error) {
      console.error('⚠️ External API failed:', error);
      publishers = generateMockPublishers(args);
      usedFallback = true;
    }
  } else {
    publishers = generateMockPublishers(args);
    usedFallback = true;
  }

  // Client-side filtering for mock data (API does server-side filtering)
  let filtered = publishers;

  // Calculate summary stats for AI
  const avgDR = filtered.length > 0 
    ? filtered.reduce((sum, p) => sum + p.authority.dr, 0) / filtered.length 
    : 0;
  
  const avgPrice = filtered.length > 0
    ? filtered.reduce((sum, p) => sum + p.pricing.base, 0) / filtered.length
    : 0;

  const dataSource = usedFallback ? '[MOCK DATA]' : '[LIVE API]';
  const summary = filtered.length === 0 
    ? `${dataSource} No publishers found matching the criteria`
    : `${dataSource} Found ${filtered.length} publishers. Average DR: ${avgDR.toFixed(1)}, Average Price: $${avgPrice.toFixed(2)}. Results displayed to user.`;

  // Result summary prepared

  return {
    publishers: filtered,
    totalCount: filtered.length,
    filters: args,
    summary
  };
}

/**
 * Build API filters following Mosaic format
 */
interface APIFilters {
  domainAuthority?: { min?: number; max?: number };
  pageAuthority?: { min?: number; max?: number };
  domainRating?: { min?: number; max?: number };
  spamScore?: { min?: number; max?: number };
  sellingPrice?: { min?: number; max?: number };
  semrushTraffic?: { min?: number; max?: number };
  semrushOrganicTraffic?: { min?: number; max?: number };
  niche?: string;
  language?: string;
  webCountry?: string;
  linkAttribute?: string;
  availability?: boolean;
  websiteRemark?: string;
  website?: string;
}

function buildAPIFilters(args: BrowsePublishersArgs): APIFilters {
  const api: APIFilters = {};
  
  if (args.daMin !== undefined) api.domainAuthority = { ...(api.domainAuthority || {}), min: args.daMin };
  if (args.daMax !== undefined) api.domainAuthority = { ...(api.domainAuthority || {}), max: args.daMax };
  if (args.paMin !== undefined) api.pageAuthority = { ...(api.pageAuthority || {}), min: args.paMin };
  if (args.paMax !== undefined) api.pageAuthority = { ...(api.pageAuthority || {}), max: args.paMax };
  if (args.drMin !== undefined) api.domainRating = { ...(api.domainRating || {}), min: args.drMin };
  if (args.drMax !== undefined) api.domainRating = { ...(api.domainRating || {}), max: args.drMax };
  if (args.spamMin !== undefined) api.spamScore = { ...(api.spamScore || {}), min: args.spamMin };
  if (args.spamMax !== undefined) api.spamScore = { ...(api.spamScore || {}), max: args.spamMax };
  if (args.priceMin !== undefined) api.sellingPrice = { ...(api.sellingPrice || {}), min: args.priceMin };
  if (args.priceMax !== undefined) api.sellingPrice = { ...(api.sellingPrice || {}), max: args.priceMax };
  if (args.semrushOverallTrafficMin !== undefined) api.semrushTraffic = { min: args.semrushOverallTrafficMin };
  if (args.semrushOrganicTrafficMin !== undefined) api.semrushOrganicTraffic = { min: args.semrushOrganicTrafficMin };
  
  if (args.niche) api.niche = args.niche;
  if (args.language) api.language = args.language;
  if (args.country) api.webCountry = args.country;
  if (args.backlinkNature) api.linkAttribute = args.backlinkNature;
  if (typeof args.availability === 'boolean') api.availability = args.availability;
  if (args.remarkIncludes) api.websiteRemark = args.remarkIncludes;
  if (args.searchQuery?.trim()) api.website = args.searchQuery.trim();
  
  return api;
}

/**
 * Build SQL-like filter query (AND-joined conditions)
 */
function buildFilterQuery(filters: APIFilters): string {
  const conditions: string[] = [];
  
  if (filters.domainAuthority?.min !== undefined) conditions.push(`"domainAuthority" >= ${filters.domainAuthority.min}`);
  if (filters.domainAuthority?.max !== undefined) conditions.push(`"domainAuthority" <= ${filters.domainAuthority.max}`);
  if (filters.pageAuthority?.min !== undefined) conditions.push(`"pageAuthority" >= ${filters.pageAuthority.min}`);
  if (filters.pageAuthority?.max !== undefined) conditions.push(`"pageAuthority" <= ${filters.pageAuthority.max}`);
  if (filters.domainRating?.min !== undefined) conditions.push(`"domainRating" >= ${filters.domainRating.min}`);
  if (filters.domainRating?.max !== undefined) conditions.push(`"domainRating" <= ${filters.domainRating.max}`);
  if (filters.spamScore?.min !== undefined) conditions.push(`"spamScore" >= ${filters.spamScore.min}`);
  if (filters.spamScore?.max !== undefined) conditions.push(`"spamScore" <= ${filters.spamScore.max}`);
  if (filters.sellingPrice?.min !== undefined) conditions.push(`"sellingPrice" >= ${filters.sellingPrice.min}`);
  if (filters.sellingPrice?.max !== undefined) conditions.push(`"sellingPrice" <= ${filters.sellingPrice.max}`);
  if (filters.semrushTraffic?.min !== undefined) conditions.push(`"semrushTraffic" >= ${filters.semrushTraffic.min}`);
  if (filters.semrushOrganicTraffic?.min !== undefined) conditions.push(`"semrushOrganicTraffic" >= ${filters.semrushOrganicTraffic.min}`);
  
  if (filters.niche) conditions.push(`"niche" = '${filters.niche}'`);
  if (filters.language) conditions.push(`"language" = '${filters.language}'`);
  if (filters.webCountry) conditions.push(`"webCountry" = '${filters.webCountry}'`);
  if (filters.linkAttribute) conditions.push(`"linkAttribute" = '${filters.linkAttribute}'`);
  if (typeof filters.availability === 'boolean') conditions.push(`"availability" = ${filters.availability}`);
  if (filters.websiteRemark) conditions.push(`"websiteRemark" LIKE '%${filters.websiteRemark}%'`);
  if (filters.website) conditions.push(`"website" LIKE '%${filters.website}%'`);
  
  return conditions.join(' AND ');
}

function generateMockPublishers(filters: BrowsePublishersArgs): PublisherData[] {
  // Mock data - replace with actual API call
  return [
    {
      id: "1",
      website: "techcrunch.com",
      websiteName: "TechCrunch",
      rating: 5,
      doFollow: true,
      niche: ["Technology", "Business"],
      type: "Premium",
      country: "United States",
      language: "English",
      authority: { dr: 92, da: 95, as: 78 },
      spam: { percentage: 2, level: "Low" },
      pricing: { base: 800, withContent: 1200 },
      trend: "Rising",
      outboundLinks: 150
    },
    {
      id: "2",
      website: "wired.com",
      websiteName: "Wired",
      rating: 5,
      doFollow: true,
      niche: ["Technology", "Science"],
      type: "Premium",
      country: "United States",
      language: "English",
      authority: { dr: 88, da: 90, as: 75 },
      spam: { percentage: 3, level: "Low" },
      pricing: { base: 650, withContent: 950 },
      trend: "Stable",
      outboundLinks: 200
    },
    {
      id: "3",
      website: "techradar.com",
      websiteName: "TechRadar",
      rating: 4,
      doFollow: true,
      niche: ["Technology", "Reviews"],
      type: "Standard",
      country: "United Kingdom",
      language: "English",
      authority: { dr: 85, da: 87, as: 72 },
      spam: { percentage: 5, level: "Low" },
      pricing: { base: 450, withContent: 700 },
      trend: "Rising",
      outboundLinks: 180
    },
    {
      id: "4",
      website: "forbes.com/technology",
      websiteName: "Forbes Tech",
      rating: 5,
      doFollow: true,
      niche: ["Technology", "Business", "Finance"],
      type: "Premium",
      country: "United States",
      language: "English",
      authority: { dr: 94, da: 96, as: 82 },
      spam: { percentage: 1, level: "Low" },
      pricing: { base: 1200, withContent: 1800 },
      trend: "Stable",
      outboundLinks: 120
    },
    {
      id: "5",
      website: "theverge.com",
      websiteName: "The Verge",
      rating: 5,
      doFollow: true,
      niche: ["Technology", "Science", "Entertainment"],
      type: "Premium",
      country: "United States",
      language: "English",
      authority: { dr: 90, da: 92, as: 79 },
      spam: { percentage: 2, level: "Low" },
      pricing: { base: 750, withContent: 1100 },
      trend: "Rising",
      outboundLinks: 165
    },
    // Add more mock publishers for testing
    {
      id: "6",
      website: "mashable.com",
      websiteName: "Mashable",
      rating: 4,
      doFollow: true,
      niche: ["Technology", "Social Media", "Entertainment"],
      type: "Standard",
      country: "United States",
      language: "English",
      authority: { dr: 82, da: 85, as: 68 },
      spam: { percentage: 8, level: "Medium" },
      pricing: { base: 500, withContent: 800 },
      trend: "Falling",
      outboundLinks: 220
    },
    {
      id: "7",
      website: "engadget.com",
      websiteName: "Engadget",
      rating: 4,
      doFollow: true,
      niche: ["Technology", "Gadgets"],
      type: "Standard",
      country: "United States",
      language: "English",
      authority: { dr: 84, da: 86, as: 70 },
      spam: { percentage: 6, level: "Low" },
      pricing: { base: 550, withContent: 850 },
      trend: "Stable",
      outboundLinks: 175
    },
    {
      id: "8",
      website: "arstechnica.com",
      websiteName: "Ars Technica",
      rating: 5,
      doFollow: true,
      niche: ["Technology", "Science"],
      type: "Premium",
      country: "United States",
      language: "English",
      authority: { dr: 86, da: 88, as: 74 },
      spam: { percentage: 4, level: "Low" },
      pricing: { base: 600, withContent: 900 },
      trend: "Rising",
      outboundLinks: 190
    }
  ];
}

