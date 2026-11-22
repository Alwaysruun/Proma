/** 插件清单中的 lucide 图标名到实际图标的映射。 */

import type { ReactNode } from 'react'
import {
  BookOpen,
  CalendarDays,
  ChartNoAxesColumn,
  Clock,
  Folder,
  Globe,
  Heart,
  ListChecks,
  ListTodo,
  Package,
  Puzzle,
  Sparkles,
  Star,
  Timer,
  Wrench,
} from 'lucide-react'

const ICONS = {
  'book-open': BookOpen,
  calendar: CalendarDays,
  'calendar-days': CalendarDays,
  chart: ChartNoAxesColumn,
  clock: Clock,
  folder: Folder,
  globe: Globe,
  heart: Heart,
  'list-checks': ListChecks,
  'list-todo': ListTodo,
  package: Package,
  puzzle: Puzzle,
  sparkles: Sparkles,
  star: Star,
  timer: Timer,
  wrench: Wrench,
} as const

export function getPluginIcon(name: string | undefined, size = 16): ReactNode {
  const Icon = name ? ICONS[name as keyof typeof ICONS] ?? Puzzle : Puzzle
  return <Icon size={size} />
}
