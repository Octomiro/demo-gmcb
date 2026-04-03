import { useTheme } from "next-themes";
import { Toaster as Sonner, toast } from "sonner";

type ToasterProps = React.ComponentProps<typeof Sonner>;

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme();

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      expand
      visibleToasts={5}
      toastOptions={{
        classNames: {
          toast:
            "group toast group-[.toaster]:bg-zinc-800 group-[.toaster]:text-zinc-50 group-[.toaster]:border-zinc-700 group-[.toaster]:shadow-lg",
          description: "group-[.toast]:text-zinc-300",
          actionButton: "group-[.toast]:bg-primary group-[.toast]:text-primary-foreground",
          cancelButton: "group-[.toast]:bg-zinc-600 group-[.toast]:text-zinc-200",
        },
      }}
      {...props}
    />
  );
};

export { Toaster, toast };
