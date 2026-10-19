using System;

// 直接调用生产启动计划校验，验证宿主版本变化和载荷篡改的处理结果。
class PlanTest
{
    static int Main(string[] a)
    {
        try
        {
            Console.Write(RuntimeProgram.ReadPlan(a[0])["packageVersion"]);
            return 0;
        }
        catch (Exception e)
        {
            Console.Write(e.Message);
            return 1;
        }
    }
}
