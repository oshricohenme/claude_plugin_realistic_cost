import type { Role, RoleId } from "./types.js"

export const ROLES: Record<RoleId, Role> = {
  pm: {
    id: "pm",
    title: "Product Manager",
    category: "management",
    defaultHourlyRate: 135,
  },
  em: {
    id: "em",
    title: "Engineering Manager",
    category: "management",
    defaultHourlyRate: 155,
  },
  designer: {
    id: "designer",
    title: "Product Designer",
    category: "design",
    defaultHourlyRate: 120,
  },
  backend: {
    id: "backend",
    title: "Senior Backend Engineer",
    category: "engineering",
    defaultHourlyRate: 115,
  },
  frontend: {
    id: "frontend",
    title: "Senior Frontend Engineer",
    category: "engineering",
    defaultHourlyRate: 110,
  },
  fullstack: {
    id: "fullstack",
    title: "Full-stack Engineer",
    category: "engineering",
    defaultHourlyRate: 112,
  },
  qa: {
    id: "qa",
    title: "QA Engineer",
    category: "quality",
    defaultHourlyRate: 90,
  },
  devops: {
    id: "devops",
    title: "DevOps / SRE",
    category: "ops",
    defaultHourlyRate: 130,
  },
  security: {
    id: "security",
    title: "Security Engineer",
    category: "security",
    defaultHourlyRate: 155,
  },
  data: {
    id: "data",
    title: "Data Engineer",
    category: "data",
    defaultHourlyRate: 120,
  },
  techwriter: {
    id: "techwriter",
    title: "Technical Writer",
    category: "engineering",
    defaultHourlyRate: 80,
  },
}

export const ROLE_ORDER: RoleId[] = [
  "pm",
  "em",
  "designer",
  "backend",
  "frontend",
  "fullstack",
  "qa",
  "devops",
  "security",
  "data",
  "techwriter",
]

export function getRole(id: RoleId): Role {
  return ROLES[id]
}
