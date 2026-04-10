import React from "react";
import clsx from "clsx";

const variants = {
  gray: "bg-gray-700 text-white fill-white",
  "gray-subtle": "bg-gray-700/30 text-gray-300 fill-gray-300",
  blue: "bg-blue-600 text-white fill-white",
  "blue-subtle": "bg-blue-900/40 text-blue-300 fill-blue-300",
  purple: "bg-purple-600 text-white fill-white",
  "purple-subtle": "bg-purple-900/40 text-purple-300 fill-purple-300",
  amber: "bg-amber-600 text-black fill-black",
  "amber-subtle": "bg-amber-900/40 text-amber-300 fill-amber-300",
  red: "bg-red-600 text-white fill-white",
  "red-subtle": "bg-red-900/40 text-red-300 fill-red-300",
  pink: "bg-pink-600 text-white fill-white",
  "pink-subtle": "bg-pink-900/40 text-pink-300 fill-pink-300",
  green: "bg-green-600 text-white fill-white",
  "green-subtle": "bg-green-900/40 text-green-300 fill-green-300",
  teal: "bg-teal-600 text-white fill-white",
  "teal-subtle": "bg-teal-900/40 text-teal-300 fill-teal-300",
  inverted: "bg-gray-200 text-gray-900 fill-gray-900",
  pill: "bg-[#1F2023] text-gray-300 fill-gray-300 border border-gray-600/40",
};

const sizes = {
  sm: "text-[10px] h-5 px-1.5 tracking-[0.2px] gap-[3px]",
  md: "text-[11px] h-6 px-2 tracking-normal gap-1",
  lg: "text-[13px] h-7 px-3 tracking-normal gap-1.5",
};

export type BadgeVariant = keyof typeof variants;

interface BadgeProps {
  children?: React.ReactNode;
  variant?: BadgeVariant;
  size?: keyof typeof sizes;
  capitalize?: boolean;
  icon?: React.ReactNode;
  href?: string;
  className?: string;
  title?: string;
}

const Content = ({
  icon,
  size,
  children,
}: {
  icon?: React.ReactNode;
  size?: string;
  children?: React.ReactNode;
}) => (
  <>
    {icon && <span className={`${size}IconContainer shrink-0`}>{icon}</span>}
    {children}
  </>
);

export function Badge({
  children,
  variant = "gray",
  size = "md",
  capitalize = false,
  icon,
  href,
  className,
  title,
}: BadgeProps) {
  const cls = clsx(
    "inline-flex justify-center items-center shrink-0 rounded-[9999px] font-sans font-medium whitespace-nowrap tabular-nums",
    capitalize && "capitalize",
    variants[variant],
    sizes[size],
    className
  );

  if (href) {
    return (
      <a
        className={clsx(cls, "no-underline hover:brightness-110 transition-all")}
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        title={title}
      >
        <Content icon={icon} size={size} children={children} />
      </a>
    );
  }

  return (
    <div className={cls} title={title}>
      <Content icon={icon} size={size} children={children} />
    </div>
  );
}

export { variants as badgeVariants };
