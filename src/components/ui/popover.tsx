"use client";

import * as React from "react";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import { menuCardClass } from "@/components/ui/menu-card";
import { cn } from "@/lib/utils";

const Popover = PopoverPrimitive.Root;
const PopoverTrigger = PopoverPrimitive.Trigger;

function PopoverContent({ className, align = "start", sideOffset = 8, ...props }: React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>): React.JSX.Element {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        align={align}
        sideOffset={sideOffset}
        className={cn(menuCardClass, "z-50 w-64 outline-none", className)}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
}

export { Popover, PopoverTrigger, PopoverContent };
